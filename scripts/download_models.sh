#!/usr/bin/env bash
# 下载 PP-OCRv6 tiny ONNX 模型（官方仓库，国内用 hf-mirror 加速）
# 用法: bash scripts/download_models.sh
set -euo pipefail

MIRROR="${HF_MIRROR:-https://hf-mirror.com}"
BASE="$MIRROR/PaddlePaddle"
OUT="$(cd "$(dirname "$0")/.." && pwd)/models"
mkdir -p "$OUT"

declare -A FILES=(
  ["PP-OCRv6_det_tiny.onnx"]="PP-OCRv6_tiny_det_onnx"
  ["PP-OCRv6_rec_tiny.onnx"]="PP-OCRv6_tiny_rec_onnx"
)

for out in "${!FILES[@]}"; do
  repo="${FILES[$out]}"
  url="$BASE/$repo/resolve/main/inference.onnx"
  if [[ -f "$OUT/$out" ]]; then
    echo "已存在: $out ($(du -h "$OUT/$out" | cut -f1))"
  else
    echo "下载: $url"
    curl -L --fail --progress-bar "$url" -o "$OUT/$out"
  fi
done
echo "完成: $(ls -lh "$OUT" | grep onnx)"
