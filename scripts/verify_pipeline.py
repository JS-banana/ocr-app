#!/usr/bin/env python3
"""PP-OCR 端到端验证脚本（Python 对照，与浏览器 pipeline 共享 manifest 契约）

用法:
    python3 scripts/verify_pipeline.py --model ppocrv6-tiny [图片路径]
    python3 scripts/verify_pipeline.py --model ppocrv6-tiny --baseline
    # 不传图片路径时自动生成一张测试图
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "public" / "models.json"

DET_MEAN = [0.485, 0.456, 0.406]
DET_STD = [0.229, 0.224, 0.225]
REC_MEAN = [0.5, 0.5, 0.5]
REC_STD = [0.5, 0.5, 0.5]

# Tiny 固定基线：框数 / 关键片段 / 最少分块；不要求全串精确相等
BASELINE_CASES = [
    {
        "id": "cn_en",
        "image": ROOT / "scripts/assets/test_input.png",
        "min_boxes": 2,
        "exact_boxes": None,
        "must_contain": ["Hello", "浏览器", "12345"],
        "min_parts": 1,
    },
    {
        "id": "bgr_color",
        "image": ROOT / "scripts/assets/baseline_bgr_color.png",
        "min_boxes": 2,
        "exact_boxes": None,
        "must_contain": ["RED", "BLUE", "通道"],
        "min_parts": 1,
    },
    {
        "id": "long_parts",
        "image": ROOT / "scripts/assets/baseline_long_parts.png",
        "min_boxes": 1,
        "exact_boxes": None,
        "must_contain": ["ABCDEF"],
        "min_parts": 2,
    },
    {
        "id": "blank",
        "image": ROOT / "scripts/assets/baseline_blank.png",
        "min_boxes": 0,
        "exact_boxes": 0,
        "must_contain": [],
        "min_parts": 0,
    },
]


def make_test_image(path: Path, size=(800, 300)) -> None:
    """生成一张带中英文的测试图"""
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(img)
    font_paths = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    ]
    font = None
    for fp in font_paths:
        if Path(fp).exists():
            try:
                font = ImageFont.truetype(fp, 40)
                break
            except Exception:
                continue
    lines = [
        "Hello World, PP-OCRv6 浏览器端测试",
        "第 2 行：识别中文和数字 12345",
    ]
    y = 30
    for line in lines:
        draw.text((30, y), line, fill="black", font=font)
        y += 70
    img.save(path)
    print(f"[测试] 已生成测试图: {path}")


def resolve_asset(url: str) -> Path:
    """本站静态 URL（/models/...）→ public 下文件"""
    if url.startswith("http://") or url.startswith("https://"):
        raise SystemExit(f"对照脚本不支持外部 URL: {url}")
    rel = url[1:] if url.startswith("/") else url
    path = ROOT / "public" / rel
    if not path.exists():
        raise SystemExit(f"缺少资产: {path}")
    return path


def load_manifest_entry(model_id: str) -> dict:
    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    models = raw.get("models")
    if not isinstance(models, list) or not models:
        raise SystemExit("models.json: models 必须是非空数组")
    for m in models:
        if isinstance(m, dict) and m.get("id") == model_id:
            return m
    raise SystemExit(f"models.json 中未找到模型 id={model_id}")


def rgba_to_chw(img: np.ndarray, mean, std, color_order: str) -> np.ndarray:
    """RGB HWC [0,255] -> CHW float32；color_order=BGR 时先交换通道"""
    x = img.astype(np.float32) / 255.0
    if color_order == "BGR":
        x = x[:, :, ::-1].copy()
    elif color_order != "RGB":
        raise SystemExit(f"不支持的 colorOrder: {color_order}")
    x = (x - np.array(mean, dtype=np.float32)) / np.array(std, dtype=np.float32)
    return x.transpose(2, 0, 1)


def db_boxes(prob: np.ndarray, scale_x: float, scale_y: float,
             thresh=0.2, box_thresh=0.4, unclip=1.4, min_side=3):
    """DBNet 后处理：二值化 -> BFS 连通域 -> unclip 外扩（与前端一致）"""
    oh, ow = prob.shape
    binmap = (prob > thresh).astype(np.uint8)

    label = np.zeros((oh, ow), dtype=np.int32)
    boxes = []
    cur = 0
    for s in range(oh * ow):
        if binmap.flat[s] != 1 or label.flat[s] != 0:
            continue
        cur += 1
        stack = [s]
        label.flat[s] = cur
        minx, miny, maxx, maxy = ow, oh, 0, 0
        acc = 0.0
        cnt = 0
        while stack:
            p = stack.pop()
            px, py = p % ow, p // ow
            minx = min(minx, px)
            maxx = max(maxx, px)
            miny = min(miny, py)
            maxy = max(maxy, py)
            acc += prob.flat[p]
            cnt += 1
            if px > 0 and binmap[py, px - 1] and not label[py, px - 1]:
                label[py, px - 1] = cur
                stack.append(p - 1)
            if px < ow - 1 and binmap[py, px + 1] and not label[py, px + 1]:
                label[py, px + 1] = cur
                stack.append(p + 1)
            if py > 0 and binmap[py - 1, px] and not label[py - 1, px]:
                label[py - 1, px] = cur
                stack.append(p - ow)
            if py < oh - 1 and binmap[py + 1, px] and not label[py + 1, px]:
                label[py + 1, px] = cur
                stack.append(p + ow)
        bw, bh = maxx - minx + 1, maxy - miny + 1
        if min(bw, bh) < min_side:
            continue
        if acc / cnt < box_thresh:
            continue
        area, peri = bw * bh, 2 * (bw + bh)
        d = area * unclip / peri
        boxes.append({
            "x0": max(0, minx - d) * scale_x,
            "y0": max(0, miny - d) * scale_y,
            "x1": min(ow, maxx + d) * scale_x,
            "y1": min(oh, maxy + d) * scale_y,
        })
    boxes.sort(key=lambda b: b["y0"])
    return boxes


def ctc_decode(data: np.ndarray, char_list, min_prob=0.0):
    """CTC 贪心解码 + 置信度（与前端一致，含 NaN 防护）

    rec 模型图内置 Softmax 时输出已是概率分布（和为 1），置信度直接取 max；
    否则按 logits 做数值稳定 softmax。
    """
    T, C = data.shape
    result = []
    confidences = []
    prev = -1
    prob_mode = None
    for t in range(T):
        row = data[t]
        finite = np.isfinite(row)
        if not finite.any():
            continue
        idx = int(np.argmax(np.where(finite, row, -1e9)))
        maxv = float(row[idx])
        if prob_mode is None:
            safe_sum = float(row[finite].sum())
            prob_mode = float(row[finite].min()) >= -1e-6 and abs(safe_sum - 1.0) < 0.02
        if idx != 0 and idx != prev:
            if prob_mode:
                p = maxv
            else:
                diff = row - maxv
                safe = np.isfinite(diff) & (diff >= -50)
                if safe.any():
                    sum_e = float(np.exp(diff[safe]).sum())
                    p = 1.0 / sum_e if sum_e > 0 else 0.001
                else:
                    p = 0.001
            p = max(0.001, min(p, 0.999))
            ch = char_list[idx] if 0 <= idx < len(char_list) else "\uFFFD"
            if p >= min_prob:
                result.append(ch)
                confidences.append(p)
        prev = idx
    conf = sum(confidences) / len(confidences) if confidences else 0.0
    return "".join(result), conf


def load_sessions(entry: dict, model_id: str):
    files = entry["files"]
    params = entry["params"]
    for key in ("det", "rec", "dict"):
        if key not in files or not isinstance(files[key], dict):
            raise SystemExit(f"model {model_id}: files.{key} 必须是 {{url,sizeBytes}}")
    for key in (
        "detMaxSide", "recHeight", "recMaxWidth", "dictSize",
        "colorOrder", "detThresh", "boxThresh", "unclipRatio", "minBoxSide",
    ):
        if key not in params:
            raise SystemExit(f"model {model_id}: 缺少 params.{key}")

    color_order = params["colorOrder"]
    if color_order != "BGR":
        raise SystemExit(f"model {model_id}: params.colorOrder 当前须为 BGR")

    det_path = resolve_asset(files["det"]["url"])
    rec_path = resolve_asset(files["rec"]["url"])
    dict_path = resolve_asset(files["dict"]["url"])

    det = ort.InferenceSession(str(det_path), providers=["CPUExecutionProvider"])
    rec = ort.InferenceSession(str(rec_path), providers=["CPUExecutionProvider"])
    chars = json.loads(dict_path.read_text(encoding="utf-8"))
    char_list = ["", *chars, " "]
    out_c = rec.get_outputs()[0].shape[-1]
    print(
        f"[模型] {model_id} 字符集: {len(chars)} + 2 = {len(char_list)} "
        f"(params.dictSize={params['dictSize']}, rec C={out_c})"
    )
    if len(char_list) != params["dictSize"]:
        raise SystemExit(
            f"字典维数不匹配: dict+2={len(char_list)} vs params.dictSize={params['dictSize']}"
        )
    if out_c is not None and int(out_c) != int(params["dictSize"]):
        raise SystemExit(
            f"rec 输出维 C={out_c} 与 params.dictSize={params['dictSize']} 不一致"
        )
    return det, rec, char_list, params, color_order


def run_ocr(img_path: Path, det, rec, char_list, params, color_order: str) -> dict:
    det_max_side = float(params["detMaxSide"])
    rec_height = int(params["recHeight"])
    rec_max_width = int(params["recMaxWidth"])
    det_thresh = float(params["detThresh"])
    box_thresh = float(params["boxThresh"])
    unclip = float(params["unclipRatio"])
    min_side = int(params["minBoxSide"])

    img = Image.open(img_path).convert("RGB")
    orig_w, orig_h = img.size
    print(f"[图片] {img_path.name} {orig_w}x{orig_h}  colorOrder={color_order}")

    r = min(1.0, det_max_side / max(orig_w, orig_h))
    det_w = max(32, round(orig_w * r / 32) * 32)
    det_h = max(32, round(orig_h * r / 32) * 32)
    resized = img.resize((det_w, det_h), Image.BILINEAR)
    chw = rgba_to_chw(np.asarray(resized), DET_MEAN, DET_STD, color_order)
    prob = det.run(None, {"x": chw[None]})[0]  # [1,1,H,W]
    prob = prob[0, 0]
    print(f"[检测] 输入 {det_w}x{det_h} -> 概率图 {prob.shape}")

    scale_x, scale_y = orig_w / prob.shape[1], orig_h / prob.shape[0]
    boxes = db_boxes(
        prob, scale_x, scale_y,
        thresh=det_thresh, box_thresh=box_thresh, unclip=unclip, min_side=min_side,
    )
    print(f"[检测] 找到 {len(boxes)} 个文本区域")

    results = []
    max_parts = 0
    for i, b in enumerate(boxes):
        cw, ch = b["x1"] - b["x0"], b["y1"] - b["y0"]
        if cw < 2 or ch < 2:
            continue
        crop = img.crop((int(b["x0"]), int(b["y0"]), int(b["x1"]), int(b["y1"])))
        rec_w = max(8, round(rec_height * cw / ch))
        parts = int(math.ceil(rec_w / rec_max_width))
        part_w = max(8, round(rec_w / parts))
        max_parts = max(max_parts, parts)

        full_text = ""
        confs = []
        for p in range(parts):
            src_x = (crop.width * p) / parts
            src_w = crop.width / parts
            left = int(src_x)
            right = int(math.ceil(src_x + src_w))
            part = crop.crop((left, 0, min(right, crop.width), crop.height))
            rec_img = part.resize((part_w, rec_height), Image.BILINEAR)
            chw_rec = rgba_to_chw(np.asarray(rec_img), REC_MEAN, REC_STD, color_order)
            out = rec.run(None, {"x": chw_rec[None]})[0][0]  # [T, C]
            text, conf = ctc_decode(out, char_list)
            full_text += text
            if text:
                confs.append(conf)

        text = full_text.strip()
        conf = sum(confs) / len(confs) if confs else 0.0
        print(
            f"  #{i+1} conf={conf:.4f} "
            f"box=({b['x0']:.0f},{b['y0']:.0f},{b['x1']:.0f},{b['y1']:.0f}) "
            f"parts={parts} -> {text!r}"
        )
        if text:
            results.append({"text": text, "conf": conf, "box": b, "parts": parts})

    joined = "".join(r["text"] for r in results)
    return {
        "boxes": len(boxes),
        "results": results,
        "joined": joined,
        "max_parts": max_parts,
    }


def assert_baseline_case(case: dict, outcome: dict) -> list[str]:
    errors: list[str] = []
    boxes = outcome["boxes"]
    if case["exact_boxes"] is not None and boxes != case["exact_boxes"]:
        errors.append(f"框数={boxes}，期望恰好 {case['exact_boxes']}")
    elif boxes < case["min_boxes"]:
        errors.append(f"框数={boxes}，期望 ≥ {case['min_boxes']}")
    if outcome["max_parts"] < case["min_parts"]:
        errors.append(
            f"最大 parts={outcome['max_parts']}，期望 ≥ {case['min_parts']}"
        )
    joined = outcome["joined"]
    for frag in case["must_contain"]:
        if frag not in joined:
            errors.append(f"缺少关键片段 {frag!r}（识别合并: {joined!r}）")
    return errors


def run_baseline(model_id: str) -> None:
    entry = load_manifest_entry(model_id)
    if entry.get("pipeline") != "ppocr-dbnet-ctc":
        raise SystemExit(f"不支持的 pipeline: {entry.get('pipeline')}")
    det, rec, char_list, params, color_order = load_sessions(entry, model_id)

    failed = 0
    for case in BASELINE_CASES:
        img_path: Path = case["image"]
        print(f"\n===== baseline:{case['id']} ({img_path.name}) =====")
        if not img_path.exists():
            print(f"FAIL: 缺少基线图片 {img_path}")
            failed += 1
            continue
        outcome = run_ocr(img_path, det, rec, char_list, params, color_order)
        errors = assert_baseline_case(case, outcome)
        if errors:
            failed += 1
            print(f"FAIL baseline:{case['id']}")
            for e in errors:
                print(f"  - {e}")
        else:
            print(
                f"PASS baseline:{case['id']} "
                f"boxes={outcome['boxes']} max_parts={outcome['max_parts']}"
            )

    if failed:
        raise SystemExit(f"Tiny baseline 失败: {failed}/{len(BASELINE_CASES)} 用例未通过")
    print(f"\n===== Tiny baseline 全部通过 ({len(BASELINE_CASES)}) =====")


def main() -> None:
    parser = argparse.ArgumentParser(description="PP-OCR Python 对照验证")
    parser.add_argument("--model", default="ppocrv6-tiny", help="模型 id（读 models.json）")
    parser.add_argument(
        "--baseline",
        action="store_true",
        help="运行 Tiny 固定基线（框数/关键片段/最少分块，失败非零退出）",
    )
    parser.add_argument("image", nargs="?", help="可选图片路径")
    args = parser.parse_args()

    if args.baseline:
        if args.image:
            raise SystemExit("--baseline 与图片路径互斥")
        if args.model != "ppocrv6-tiny":
            raise SystemExit(
                f"--baseline 仅支持 ppocrv6-tiny（收到 --model {args.model}）；"
                "勿用 Small/Medium 误跑 Tiny 基线"
            )
        run_baseline(args.model)
        return

    entry = load_manifest_entry(args.model)
    if entry.get("pipeline") != "ppocr-dbnet-ctc":
        raise SystemExit(f"不支持的 pipeline: {entry.get('pipeline')}")

    img_path = Path(args.image) if args.image else ROOT / "scripts/assets/test_input.png"
    if not img_path.exists():
        make_test_image(img_path)
    else:
        print(f"[测试] 使用图片: {img_path}")

    det, rec, char_list, params, color_order = load_sessions(entry, args.model)
    outcome = run_ocr(img_path, det, rec, char_list, params, color_order)

    if outcome["boxes"] == 0:
        print("[结果] 未检测到文本")
        # 单图探索模式仍允许 0 框；Gate 请用 --baseline
        return

    print("\n===== 最终结果 =====")
    for i, item in enumerate(outcome["results"]):
        print(f"#{i+1}  conf {item['conf']*100:.2f}%  {item['text']}")


if __name__ == "__main__":
    main()
