<div align="center">
  <img src="app/icon.svg" width="96" alt="OCR-APP logo">
  <h1>OCR-APP</h1>
  <p>本地 OCR · 图片文字识别</p>
  <p>PP-OCRv6 三档模型，推理全在浏览器完成。</p>
</div>

粘贴、拖入或选择图片后自动识别。提供 Tiny / Small / Medium 三档模型（约 6MB / 30MB / 132MB），结果带置信度、标注框与耗时，可复制或下载 `.txt`。仅支持桌面浏览器（`min-width` 1180px）。

## 快速开始

需要 Node.js 22+ 与 pnpm。

```bash
pnpm install
bash scripts/download_models.sh --model ppocrv6-tiny   # 约 6MB；可再下 small / medium
python3 scripts/extract_charset.py --model ppocrv6-tiny
pnpm dev   # http://localhost:3000
```

> [!NOTE]
> `public/models/` 与 `public/ort/` 不入库。权重按 `public/models/<id>/{det,rec}.onnx` + `dict.json` 存放；`ort` 由 `pnpm install` 自动拷贝。

## 部署

本地静态产物：

```bash
pnpm build
# 将 out/ 与 public/models/ 一并发布到静态托管
```

GitHub Pages：推送 `main` 后由 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) 自动构建并发布（含三档模型下载）。站点地址：

https://js-banana.github.io/ocr-app/

## 开发

常用检查：`pnpm lint` · `pnpm test` · `pnpm exec tsc --noEmit`。

流水线对照、字符集与 Session 约定见 [`AGENTS.md`](AGENTS.md)。模型来源：[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) · [PP-OCRv6 ONNX（Apache-2.0）](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx)。

## License

本仓库暂无 `LICENSE` 文件。上游 PP-OCRv6 ONNX 权重标注为 Apache-2.0，使用前请自行核对。
