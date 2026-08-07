# AGENTS.md

浏览器端 OCR 验证站：PP-OCRv6 tiny + onnxruntime-web，纯客户端推理，Next.js 静态导出后由 nginx/Cloudflare 分发。研究目标是小模型 OCR 与客户端（web）可运行性；当前正式产品形态以本仓库根目录 Next.js 工程为准。

`CLAUDE.md` 仅 `@AGENTS.md` 适配；本文件为跨工具规范源。

## Stack

- Node 22+ / pnpm（lockfile 为 `pnpm-lock.yaml`；`packageManager` 见 `package.json`）
- Next.js 16.3 / React 19 / TypeScript strict / Tailwind CSS v4
- `onnxruntime-web`（浏览器推理；对 Node 显式禁用）
- 研究侧：`python3` + `onnxruntime` / `Pillow` / `PyYAML`（见 `scripts/`）

## Commands

- Install: `pnpm install`（`postinstall` 会把 ort wasm 拷到 `public/ort/`）
- Dev: `pnpm dev`
- Build: `pnpm build`（`prebuild` 再拷 ort；产物 `out/`）
- Lint: `pnpm lint`
- Typecheck: `pnpm exec tsc --noEmit`
- 缺模型权重: `bash scripts/download_models.sh`（默认 `HF_MIRROR=https://hf-mirror.com`）
- 缺/升级字符集: 先有 `scripts/inference_rec.yml`，再 `python3 scripts/extract_charset.py`
- Python 端到端对照: `python3 scripts/verify_pipeline.py [图片路径]`

## Non-Obvious Patterns

- **静态导出**：`next.config.ts` 固定 `output: "export"`。不要加依赖 Node runtime 的 Route Handler / SSR 专属能力；图片走 `images.unoptimized`。
- **客户端隔离**：`onnxruntime-web` 只能在浏览器跑。OCR UI 用 `next/dynamic(..., { ssr: false })` 加载（见 `app/page.tsx`）；推理逻辑放 `lib/ocr/`，勿在服务端 import。
- **全量 ort 入口**：必须 `import * as ort from "onnxruntime-web"`。不要用 `/webgpu` 条件入口——其中不含 webgl，而 webgl 是 iOS/Safari 的 GPU 兜底。
- **清单驱动模型**：模型元数据只维护 `public/models.json`；UI/加载读清单，代码不写死路径与参数。
- **生成资产勿手改**：`public/ort/` 由 `postinstall`/`prebuild` 生成（gitignore）；权重与字典在 `public/models/`（gitignore）。改 ort 拷贝逻辑改 `package.json` scripts，不手工塞文件。
- **字符集维数**：官方 dict 约 6904 字；前端/Python 使用 `[''] + chars + [' ']` → `dictSize` 6906。错字典会整页乱码；升级模型时用 `extract_charset.py`，勿拿外部 6622 字典凑合。
- **解码防 NaN**：识别 softmax/`Math.exp` 路径必须 `isFinite` 过滤，否则单点 NaN 会整行污染（见 `lib/ocr/ppocr.ts`）。
- **wasm 线程**：`ort.env.wasm.numThreads = 1`，避免依赖 COOP/COEP；`wasmPaths = "/ort/"`。

## Boundaries

### Always

- 改 OCR 行为时同步考虑 `lib/ocr/*` 与（若触及流水线）`scripts/verify_pipeline.py`。
- 新增/调整模型：先改 `public/models.json`，再补权重与匹配字符集。

### Ask First

- 增加 pnpm / Python 依赖。
- 取消静态导出，或引入需要服务端的 API。
- 改 `ort.env.wasm` 多线程、跨域隔离头，或部署缓存策略。
- 提交/改动 gitignore 中的大文件（模型、ort、docs）。

### Never

- 提交密钥或 `.env*`。
- 手改 `public/ort/`、`out/`、`.next/`。
- 在 Node/SSR 路径直接 `import "onnxruntime-web"`。
- 用错误字符集或跳过 `isFinite` 防护“优化”识别。

## Verification

- 前端逻辑：`pnpm lint`；触及类型时再 `pnpm exec tsc --noEmit`。
- 流水线回归：有模型时跑 `python3 scripts/verify_pipeline.py`；浏览器路径用 `pnpm dev` 加载清单并实测识别。
- 发布前：`pnpm build`，确认 `out/` 含页面与 `/ort`、`/models.json`（权重需另行放到服务器 `models/`）。
- 若某检查无法运行，在回复里写明命令与原因。

## Reference Map

- 人读总览与踩坑：`README.md`（已入库；优先看）
- 产品方案 / 技术选型 / 源文整理：本地 `docs/*`（gitignore，克隆机可能没有）
  - 改产品逻辑前读 `docs/web-playground-plan.md`（若存在）
  - 改部署/缓存/选型前读 `docs/nextjs-tailwind-research.md`（若存在）

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
