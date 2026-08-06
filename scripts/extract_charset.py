#!/usr/bin/env python3
"""从 PP-OCRv6 官方 inference.yml 提取字符集，生成 public/models/ppocr_keys_v6_tiny.json

官方仓库已把字符集嵌在模型配置里（PostProcess.character_dict），
无需像老教程那样解析 ONNX protobuf 元数据。

用法:
    bash scripts/download_models.sh  # 同时下载 inference.yml 或手动放入 scripts/
    python3 scripts/extract_charset.py
"""
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(__file__).parent / "inference_rec.yml"

if not SRC.exists():
    raise SystemExit(
        "缺少 inference_rec.yml，请先下载:\n"
        "  curl -L -o scripts/inference_rec.yml "
        "https://hf-mirror.com/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.yml"
    )

cfg = yaml.safe_load(SRC.read_text(encoding="utf-8"))
chars = cfg["PostProcess"]["character_dict"]

out_path = ROOT / "public/models/ppocr_keys_v6_tiny.json"
out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(
    json.dumps(chars, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
)
print(f"字符集 {len(chars)} 个字符 -> {out_path}")
print(f"前端使用: charList = [''] + 字符集 + [' ']  = {len(chars) + 2} 维 (模型输出)")
