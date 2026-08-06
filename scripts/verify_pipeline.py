#!/usr/bin/env python3
"""PP-OCRv6 tiny 端到端验证脚本（Python 版，与前端 pipeline 逻辑对应）

用法:
    python3 scripts/verify_pipeline.py [图片路径]
    # 不传图片路径时自动生成一张测试图
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent

DET_MAX_SIDE = 960
DET_MEAN = [0.485, 0.456, 0.406]
DET_STD = [0.229, 0.224, 0.225]
REC_MEAN = [0.5, 0.5, 0.5]
REC_STD = [0.5, 0.5, 0.5]
REC_HEIGHT = 48
REC_MAX_WIDTH = 3200  # 官方推荐上限（输入 3200 宽时 T=400）


def make_test_image(path: Path, size=(800, 300)) -> None:
    """生成一张带中英文的测试图"""
    img = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(img)
    # 找可用中文字体
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


def rgba_to_chw(img: np.ndarray, mean, std) -> np.ndarray:
    """RGB HWC [0,255] -> CHW float32 归一化"""
    x = img.astype(np.float32) / 255.0
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
    """CTC 贪心解码 + 置信度（与前端一致，含 NaN 防护）"""
    T, C = data.shape
    result = []
    confidences = []
    prev = -1
    for t in range(T):
        row = data[t]
        finite = np.isfinite(row)
        if not finite.any():
            continue
        idx = int(np.argmax(np.where(finite, row, -1e9)))
        maxv = float(row[idx])
        if idx != 0 and idx != prev:
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


def main():
    img_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "web/test_input.png"
    if not img_path.exists():
        make_test_image(img_path)
    else:
        print(f"[测试] 使用图片: {img_path}")

    # 加载模型与字符集
    det = ort.InferenceSession(str(ROOT / "models/PP-OCRv6_det_tiny.onnx"),
                               providers=["CPUExecutionProvider"])
    rec = ort.InferenceSession(str(ROOT / "models/PP-OCRv6_rec_tiny.onnx"),
                               providers=["CPUExecutionProvider"])
    dict_path = ROOT / "web/ppocr_keys_v6_tiny.json"
    chars = json.loads(dict_path.read_text(encoding="utf-8"))
    char_list = ["", *chars, " "]  # blank(0) + 6904 + space = 6906
    print(f"[模型] 字符集: {len(chars)} + 2 = {len(char_list)} (模型输出维 {rec.get_outputs()[0].shape[-1]})")

    img = Image.open(img_path).convert("RGB")
    orig_w, orig_h = img.size
    print(f"[图片] {orig_w}x{orig_h}")

    # ---- 检测 ----
    r = min(1.0, DET_MAX_SIDE / max(orig_w, orig_h))
    det_w = max(32, round(orig_w * r / 32) * 32)
    det_h = max(32, round(orig_h * r / 32) * 32)
    resized = img.resize((det_w, det_h), Image.BILINEAR)
    chw = rgba_to_chw(np.asarray(resized), DET_MEAN, DET_STD)
    prob = det.run(None, {"x": chw[None]})[0]  # [1,1,H,W]
    prob = prob[0, 0]  # 单通道概率图
    print(f"[检测] 输入 {det_w}x{det_h} -> 概率图 {prob.shape}")

    scale_x, scale_y = orig_w / prob.shape[1], orig_h / prob.shape[0]
    boxes = db_boxes(prob, scale_x, scale_y)
    print(f"[检测] 找到 {len(boxes)} 个文本区域")
    if not boxes:
        print("[结果] 未检测到文本")
        return

    # ---- 识别 ----
    results = []
    for i, b in enumerate(boxes):
        cw, ch = b["x1"] - b["x0"], b["y1"] - b["y0"]
        if cw < 2 or ch < 2:
            continue
        crop = img.crop((int(b["x0"]), int(b["y0"]), int(b["x1"]), int(b["y1"])))
        rec_w = max(8, round(REC_HEIGHT * cw / ch))
        rec_w = min(rec_w, REC_MAX_WIDTH)
        rec_img = crop.resize((rec_w, REC_HEIGHT), Image.BILINEAR)
        chw_rec = rgba_to_chw(np.asarray(rec_img), REC_MEAN, REC_STD)
        out = rec.run(None, {"x": chw_rec[None]})[0][0]  # [T, 6906]
        text, conf = ctc_decode(out, char_list)
        text = text.strip()
        print(f"  #{i+1} conf={conf:.4f} box=({b['x0']:.0f},{b['y0']:.0f},{b['x1']:.0f},{b['y1']:.0f}) -> {text!r}")
        if text:
            results.append((text, conf, b))

    print("\n===== 最终结果 =====")
    for i, (text, conf, _) in enumerate(results):
        print(f"#{i+1}  conf {conf*100:.2f}%  {text}")


if __name__ == "__main__":
    main()
