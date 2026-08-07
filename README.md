# OCR-APP — 浏览器端 OCR 验证站

纯前端 OCR 试验场：用约 **6MB** 的 PP-OCRv6 tiny + `onnxruntime-web`，在访客浏览器里完成选模型、加载与识别；服务器只分发静态文件。

适合想验证「小模型能否在 Web 上跑通、CPU/GPU 后端怎么回退」的开发者与研究者。技术栈为 **Next.js 16（静态导出）+ Tailwind CSS v4 + TypeScript**。

## 快速开始

需要 Node.js 22+ 与 pnpm。

```bash
pnpm install                    # postinstall 会拷贝 ort wasm → public/ort/
bash scripts/download_models.sh # 下载 det/rec ONNX（默认 hf-mirror）
pnpm dev                        # http://localhost:3000
```

首次使用还需字符集（与模型绑定，错字典会整页乱码）：

```bash
# 若尚无 scripts/inference_rec.yml：
curl -L -o scripts/inference_rec.yml \
  "https://hf-mirror.com/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.yml"

python3 scripts/extract_charset.py   # 生成 public/models/ppocr_keys_v6_tiny.json
```

浏览器打开后：选模型 → 等待加载 → 上传图片 → 识别。后端按 `webgpu → webgl → wasm` 自动回退，结果区会显示实际后端与耗时。

> [!NOTE]
> `public/models/` 与 `public/ort/` 不入库；克隆后必须走上述安装/下载步骤。

## 它做什么

- **清单驱动**：模型信息只维护在 `public/models.json`，UI 与加载逻辑读清单，不写死路径。
- **本机缓存**：权重经 Cache API（`ocr-models-v1`）缓存，下载一次可离线复用。
- **纯静态部署**：`pnpm build` 导出到 `out/`，用 nginx / Cloudflare / 任意静态托管即可。

## 部署

```bash
pnpm build
rsync -avz --delete out/ server:~/ocr-web/
```

记得把 `public/models/` 下的权重与字符集一并放到站点可访问路径（与 `models.json` 中路径一致）。`.onnx` / `.wasm` 宜长缓存，HTML 宜每次校验。

## 仓库地图

| 路径 | 作用 |
|------|------|
| `app/` | Next.js App Router 入口（OCR 页 `ssr: false` 动态加载） |
| `components/ocr-client.tsx` | 模型选择 / 上传 / 识别 / 结果 UI |
| `lib/ocr/` | DBNet+CTC 流水线、Cache 加载、类型 |
| `public/models.json` | 模型注册表（需入库维护） |
| `public/models/` | ONNX + 字典（gitignore） |
| `public/ort/` | ort wasm（`postinstall` / `prebuild` 生成） |
| `scripts/` | 下载模型、提字符集、Python 端到端对照 |
| `out/` | 静态导出产物 |

## 研究工具链

```bash
bash scripts/download_models.sh              # ONNX → public/models/
python3 scripts/extract_charset.py           # 升级模型时重提字符集
python3 scripts/verify_pipeline.py [图片]    # 无需浏览器的流水线对照
pnpm lint
pnpm exec tsc --noEmit
```

Python 侧需本机安装 `onnxruntime`、`Pillow`、`PyYAML`（未写入 pnpm 依赖）。

## 踩坑备忘

1. **字符集必须匹配模型**：官方 `inference.yml` 约 6904 字；前端使用 `[''] + chars + [' ']` → `dictSize` 6906。
2. **softmax 防 NaN**：输出含 NaN 时要 `isFinite`，否则整行污染（见 `lib/ocr/ppocr.ts`）。
3. **det 输出**为单通道 `[N,1,H,W]`，概率图分辨率与输入一致。
4. **ort wasm 整套拷贝**：`ort-wasm-simd-threaded.*`（mjs + wasm 全家），勿只拷单个 `.wasm`。
5. **全量导入 ort**：`import * as ort from "onnxruntime-web"`；`/webgpu` 入口不含 webgl，而 webgl 是 iOS/Safari 的 GPU 兜底。

## 参考

- 模型（Apache-2.0）：[PP-OCRv6_tiny_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx) · [PP-OCRv6_tiny_rec_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx)
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) · [onnxruntime](https://github.com/microsoft/onnxruntime)
- 给编码代理的仓库约定见 `AGENTS.md`
- 本地可选研究笔记：`docs/`（默认 gitignore，克隆机可能没有）

## License

本仓库暂无 `LICENSE` 文件。所依赖的 PP-OCRv6 tiny ONNX 权重标注为 Apache-2.0；使用前请自行核对上游许可。
