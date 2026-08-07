#!/usr/bin/env bash
# 下载 PP-OCRv6 ONNX 模型（官方仓库，国内用 hf-mirror 加速）
# macOS bash 3.2 兼容：无 associative array、无 mapfile。
# 落盘布局：public/models/<model-id>/{det,rec}.onnx（字典由 extract_charset.py 生成）
#
# 用法:
#   bash scripts/download_models.sh --model ppocrv6-tiny
#   bash scripts/download_models.sh --model ppocrv6-small
#   bash scripts/download_models.sh --model ppocrv6-medium
set -euo pipefail

MIRROR="${HF_MIRROR:-https://hf-mirror.com}"
BASE="$MIRROR/PaddlePaddle"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/models"

MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model)
      if [ $# -lt 2 ]; then
        echo "missing --model value" >&2
        exit 2
      fi
      MODEL="$2"
      shift 2
      ;;
    --model=*)
      MODEL="${1#*=}"
      shift
      ;;
    -h|--help)
      echo "usage: bash scripts/download_models.sh --model ppocrv6-tiny|small|medium"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$MODEL" ]; then
  MODEL="ppocrv6-tiny"
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "need shasum or sha256sum" >&2
    exit 1
  fi
}

download_atomic() {
  _url="$1"
  _dest="$2"
  _tmp="${_dest}.part.$$"
  echo "download: $_url"
  if ! curl -L --fail --progress-bar "$_url" -o "$_tmp"; then
    rm -f "$_tmp"
    echo "failed: $_url" >&2
    exit 1
  fi
  mv "$_tmp" "$_dest"
  _sz=$(wc -c < "$_dest" | tr -d ' ')
  _digest=$(sha256_file "$_dest")
  echo "  ok $(basename "$_dest") sizeBytes=${_sz} sha256=${_digest}"
}

skip_or_fetch() {
  _out_name="$1"
  _repo="$2"
  _remote="$3"
  _dest="$4"
  _url="${BASE}/${_repo}/resolve/main/${_remote}"
  mkdir -p "$(dirname "$_dest")"
  if [ -f "$_dest" ]; then
    _sz=$(wc -c < "$_dest" | tr -d ' ')
    _digest=$(sha256_file "$_dest")
    echo "exists ${_out_name} sizeBytes=${_sz} sha256=${_digest} (skip, offline)"
    return 0
  fi
  download_atomic "$_url" "$_dest"
}

case "$MODEL" in
  ppocrv6-tiny)
    skip_or_fetch "ppocrv6-tiny/det.onnx" "PP-OCRv6_tiny_det_onnx" "inference.onnx" \
      "$OUT/ppocrv6-tiny/det.onnx"
    skip_or_fetch "ppocrv6-tiny/rec.onnx" "PP-OCRv6_tiny_rec_onnx" "inference.onnx" \
      "$OUT/ppocrv6-tiny/rec.onnx"
    skip_or_fetch "inference_rec.yml" "PP-OCRv6_tiny_rec_onnx" "inference.yml" \
      "$ROOT/scripts/inference_rec.yml"
    skip_or_fetch "inference_det_tiny.yml" "PP-OCRv6_tiny_det_onnx" "inference.yml" \
      "$ROOT/scripts/inference_det_tiny.yml"
    echo "done: tiny weights under $OUT/ppocrv6-tiny (dict via extract_charset.py)"
    ;;
  ppocrv6-small)
    skip_or_fetch "ppocrv6-small/det.onnx" "PP-OCRv6_small_det_onnx" "inference.onnx" \
      "$OUT/ppocrv6-small/det.onnx"
    skip_or_fetch "ppocrv6-small/rec.onnx" "PP-OCRv6_small_rec_onnx" "inference.onnx" \
      "$OUT/ppocrv6-small/rec.onnx"
    skip_or_fetch "inference_det_small.yml" "PP-OCRv6_small_det_onnx" "inference.yml" \
      "$ROOT/scripts/inference_det_small.yml"
    skip_or_fetch "inference_rec_small.yml" "PP-OCRv6_small_rec_onnx" "inference.yml" \
      "$ROOT/scripts/inference_rec_small.yml"
    echo "done: small weights under $OUT/ppocrv6-small (dict via extract_charset.py)"
    ;;
  ppocrv6-medium)
    skip_or_fetch "ppocrv6-medium/det.onnx" "PP-OCRv6_medium_det_onnx" "inference.onnx" \
      "$OUT/ppocrv6-medium/det.onnx"
    skip_or_fetch "ppocrv6-medium/rec.onnx" "PP-OCRv6_medium_rec_onnx" "inference.onnx" \
      "$OUT/ppocrv6-medium/rec.onnx"
    skip_or_fetch "inference_det_medium.yml" "PP-OCRv6_medium_det_onnx" "inference.yml" \
      "$ROOT/scripts/inference_det_medium.yml"
    skip_or_fetch "inference_rec_medium.yml" "PP-OCRv6_medium_rec_onnx" "inference.yml" \
      "$ROOT/scripts/inference_rec_medium.yml"
    echo "done: medium weights under $OUT/ppocrv6-medium (dict via extract_charset.py)"
    ;;
  *)
    echo "unknown model: $MODEL (ppocrv6-tiny|ppocrv6-small|ppocrv6-medium)" >&2
    exit 2
    ;;
esac
