#!/usr/bin/env python3
"""从 PP-OCRv6 官方 inference.yml 提取字符集。

落盘：public/models/<model-id>/dict.json
Small 写出后同步拷贝到 Medium（内容相同，各档自包含）。
Medium 为校验模式：与 Small 字典及官方 yml 严格一致。

用法:
    python3 scripts/extract_charset.py --model ppocrv6-tiny
    python3 scripts/extract_charset.py --model ppocrv6-small
    python3 scripts/extract_charset.py --model ppocrv6-medium
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "public" / "models"

MODEL_CFG = {
    "ppocrv6-tiny": {
        "yml": Path(__file__).parent / "inference_rec.yml",
        "out": MODELS / "ppocrv6-tiny" / "dict.json",
        "mode": "write",
    },
    "ppocrv6-small": {
        "yml": Path(__file__).parent / "inference_rec_small.yml",
        "out": MODELS / "ppocrv6-small" / "dict.json",
        "mirror": MODELS / "ppocrv6-medium" / "dict.json",
        "mode": "write",
    },
    "ppocrv6-medium": {
        "yml": Path(__file__).parent / "inference_rec_medium.yml",
        "out": MODELS / "ppocrv6-medium" / "dict.json",
        "mode": "verify-small",
        "peer": MODELS / "ppocrv6-small" / "dict.json",
    },
}


def load_chars(yml_path: Path) -> list[str]:
    if not yml_path.exists():
        raise SystemExit(
            f"缺少 {yml_path.name}，请先准备官方 inference.yml:\n"
            f"  bash scripts/download_models.sh --model <id>"
        )
    cfg = yaml.safe_load(yml_path.read_text(encoding="utf-8"))
    chars = cfg["PostProcess"]["character_dict"]
    if not isinstance(chars, list) or not all(isinstance(c, str) for c in chars):
        raise SystemExit(f"{yml_path}: PostProcess.character_dict 必须是 string[]")
    return chars


def write_dict(chars: list[str], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(chars, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="提取/校验 PP-OCR 字符集")
    parser.add_argument(
        "--model",
        required=True,
        choices=sorted(MODEL_CFG.keys()),
        help="模型 id",
    )
    args = parser.parse_args()
    cfg = MODEL_CFG[args.model]

    if cfg["mode"] == "write":
        chars = load_chars(cfg["yml"])
        out_path: Path = cfg["out"]
        write_dict(chars, out_path)
        print(f"字符集 {len(chars)} 个字符 -> {out_path}")
        mirror = cfg.get("mirror")
        if isinstance(mirror, Path):
            mirror.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(out_path, mirror)
            print(f"已同步拷贝 -> {mirror}")
        print(f"前端使用: [''] + chars + [' '] = {len(chars) + 2} 维")
        return

    # medium：不重复生成字符表，校验与 Small 一致后确保本档 dict.json 存在
    if args.model == "ppocrv6-medium":
        peer: Path = cfg["peer"]
        out_path = cfg["out"]
        if not peer.exists():
            raise SystemExit(
                f"Medium 校验需要先生成 Small 字典: {peer}\n"
                "  python3 scripts/extract_charset.py --model ppocrv6-small"
            )
        yml: Path = cfg["yml"]
        if not yml.exists():
            raise SystemExit(
                f"缺少 {yml.name}；Medium 必须与 Small 做严格比对，"
                "不可在缺 yml 时假成功。请先 download_models.sh --model ppocrv6-medium。"
            )
        small_chars = json.loads(peer.read_text(encoding="utf-8"))
        medium_chars = load_chars(yml)
        if medium_chars != small_chars:
            raise SystemExit("Medium 字符集与 Small 不一致")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(peer, out_path)
        print(f"Medium 字符集与 Small 一致（{len(small_chars)} 字）-> {out_path}")
        return

    raise SystemExit(f"未实现的模式: {cfg['mode']}")


if __name__ == "__main__":
    main()
