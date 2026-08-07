# OCR-APP — 本地 OCR · 图片文字识别

桌面端 OCR 产品：初始上传页 → 三栏工作区（原图标注框 / 逐行结果 / 模型与操作）。PP-OCRv6 **Tiny / Small / Medium** 三档模型（约 6MB / 30MB / 132MB）+ `onnxruntime-web`，全部推理在访客浏览器本地完成，服务器只分发静态文件。

仅支持桌面浏览器（页面 `min-width` 1180px，验收视口 1280×720 / 1440×900 / 1920×1080）。技术栈为 **Next.js 16（静态导出）+ Tailwind CSS v4 + TypeScript**。

## 快速开始

需要 Node.js 22+ 与 pnpm。

```bash
pnpm install                                     # postinstall 会拷贝 ort wasm → public/ort/
bash scripts/download_models.sh --model ppocrv6-tiny    # 默认档（约 6MB）
bash scripts/download_models.sh --model ppocrv6-small   # 可选（约 30MB）
bash scripts/download_models.sh --model ppocrv6-medium  # 可选（约 132MB）
pnpm dev                                         # http://localhost:3000
```

字符集与模型绑定（错字典会整页乱码）；下载脚本已带回官方 `inference*.yml` 后：

```bash
python3 scripts/extract_charset.py --model ppocrv6-tiny    # → ppocr_keys_v6_tiny.json（6904 字）
python3 scripts/extract_charset.py --model ppocrv6-small   # → ppocr_keys_v6_full.json（18708 字）
python3 scripts/extract_charset.py --model ppocrv6-medium  # 校验与 Small 字典一致（不重复生成）
```

浏览器打开后：粘贴 / 拖入 / 选择图片 → 点击识别（Tiny 默认后台加载，Small/Medium 按需）。后端按 `webgpu → webgl → wasm` 自动回退；结果区给出逐行置信度、图上标注框与 det/rec 耗时、实际后端，可复制全文或下载 `.txt`。

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
| `components/ocr-client.tsx` | 初始上传页 + 三栏工作区（粘贴/拖放上传、模型卡、复制/.txt 下载） |
| `lib/ocr/` | manifest 校验、Cache 加载、runtime 生命周期、DBNet+CTC 流水线 |
| `public/models.json` | 三模型注册表（需入库维护） |
| `public/models/` | ONNX + 字典（gitignore） |
| `public/ort/` | ort wasm（`postinstall` / `prebuild` 生成） |
| `scripts/` | 下载模型、提字符集、Python 端到端对照 |
| `out/` | 静态导出产物 |

## 研究工具链

```bash
bash scripts/download_models.sh --model <id>      # ONNX + 官方 yml → public/models/、scripts/
python3 scripts/extract_charset.py --model <id>   # 升级模型时重提/校验字符集
python3 scripts/verify_pipeline.py --model <id> [图片]   # 无需浏览器的流水线对照
python3 scripts/verify_pipeline.py --model ppocrv6-tiny --baseline  # Tiny 固定基线
pnpm lint
pnpm exec tsc --noEmit
pnpm test                                          # Node 22 内置测试（manifest + runtime）
```

Python 侧需本机安装 `onnxruntime`、`Pillow`、`PyYAML`（未写入 pnpm 依赖）。

## 踩坑备忘

1. **字符集必须匹配模型**：Tiny 6904 字 → `[''] + chars + [' ']` = `dictSize` 6906；Small/Medium 共用 18708 字 → 18710。
2. **softmax 防 NaN**：输出含 NaN 时要 `isFinite`，否则整行污染（见 `lib/ocr/pipelines/ppocr-dbnet-ctc.ts`）。
3. **det 输出**为单通道 `[N,1,H,W]`，概率图分辨率与输入一致。
4. **ort wasm 整套拷贝**：`ort-wasm-simd-threaded.*`（mjs + wasm 全家），勿只拷单个 `.wasm`。
5. **全量导入 ort**：`import * as ort from "onnxruntime-web"`；`/webgpu` 入口不含 webgl，而 webgl 是 iOS/Safari 的 GPU 兜底。
6. **Session 生命周期只经 `lib/ocr/runtime.ts`**：Tiny/Small 常驻共存，Medium 独占（选中前释放其他 Session）；UI 不直接持有 Pipeline。

## 参考

- 模型（Apache-2.0）：[PP-OCRv6_tiny_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx) · [PP-OCRv6_tiny_rec_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx)（Small/Medium 为同名 `PP-OCRv6_{small,medium}_{det,rec}_onnx` 仓库）
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) · [onnxruntime](https://github.com/microsoft/onnxruntime)
- 给编码代理的仓库约定见 `AGENTS.md`
- 本地可选研究笔记：`docs/`（默认 gitignore，克隆机可能没有）

## License

本仓库暂无 `LICENSE` 文件。所依赖的 PP-OCRv6 ONNX 权重标注为 Apache-2.0；使用前请自行核对上游许可。
