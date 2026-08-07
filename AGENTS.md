# AGENTS.md

本地 OCR 桌面产品：PP-OCRv6 Tiny / Small / Medium 三档 + onnxruntime-web，纯客户端推理，Next.js 静态导出后由 nginx/Cloudflare 分发。界面为初始上传页 + 三栏工作区（方案见 `docs/multi-model-architecture-plan.md` 第 6 节）。研究目标是小模型 OCR 与客户端（web）可运行性。

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
- Test: `pnpm test`（Node 22 内置 runner + `--experimental-strip-types`；manifest 与 runtime）
- 缺模型权重: `bash scripts/download_models.sh --model ppocrv6-tiny|ppocrv6-small|ppocrv6-medium`（幂等；默认 `HF_MIRROR=https://hf-mirror.com`；同时带回官方 `inference*.yml`）
- 缺/升级字符集: `python3 scripts/extract_charset.py --model <id>`（medium 为校验模式，需先生成 small 字典）
- Python 端到端对照: `python3 scripts/verify_pipeline.py --model <id> [图片路径]`；Tiny 固定基线加 `--baseline`

## Non-Obvious Patterns

- **静态导出**：`next.config.ts` 固定 `output: "export"`。不要加依赖 Node runtime 的 Route Handler / SSR 专属能力；图片走 `images.unoptimized`。
- **客户端隔离**：`onnxruntime-web` 只能在浏览器跑。OCR UI 用 `next/dynamic(..., { ssr: false })` 加载（见 `app/page.tsx`）；推理逻辑放 `lib/ocr/`，勿在服务端 import。
- **全量 ort 入口**：必须 `import * as ort from "onnxruntime-web"`。不要用 `/webgpu` 条件入口——其中不含 webgl，而 webgl 是 iOS/Safari 的 GPU 兜底。
- **清单驱动模型**：模型元数据只维护 `public/models.json`；UI/加载读清单，代码不写死路径与参数。条目经 `lib/ocr/manifest.ts` 全字段运行时校验（含 `/models/` 路径白名单），TS 断言不代替校验。
- **Session 生命周期**：`lib/ocr/runtime.ts` 是唯一所有者：Promise 去重、selection generation 双检、transition lock 串行化 Session 创建/释放、Tiny/Small 常驻共存、Medium 独占、busy 拒绝切换、dispose 收口不复活。UI 不直接持有 Pipeline；测试注入 `loadAssets`/`createPipeline` 替身（runtime 无相对路径值导入，Node 可直接测）。
- **生成资产勿手改**：`public/ort/` 由 `postinstall`/`prebuild` 生成（gitignore）；权重与字典在 `public/models/`（gitignore）。改 ort 拷贝逻辑改 `package.json` scripts，不手工塞文件。
- **模型目录**：权重与字典按 id 落在 `public/models/<id>/{det,rec}.onnx` 与 `dict.json`（`ort` 仍平铺 `/ort/`，勿改）。清单 url 须与此一致。
- **字符集维数**：Tiny dict 6904 字 → `[''] + chars + [' ']` → `dictSize` 6906；Small/Medium 各档 `dict.json` 内容相同（18708 字 → 18710）。错字典会整页乱码；升级模型时用 `extract_charset.py`，勿拿外部 6622 字典凑合。
- **解码防 NaN**：识别 softmax/`Math.exp` 路径必须 `isFinite` 过滤，否则单点 NaN 会整行污染（见 `lib/ocr/pipelines/ppocr-dbnet-ctc.ts`）。
- **wasm 线程**：`ort.env.wasm.numThreads = 1`，避免依赖 COOP/COEP；`wasmPaths = "/ort/"`。
- **桌面 UI 边界**：`globals.css` 设 `body { min-width: 1180px }`，不写移动端/触控规则；配色在 `@theme`（琥珀 `#f0a23a` 只用于选中/关键按钮/进度，小号文字用 `accent-ink`）。模型卡用 `radiogroup/radio` + 方向键（roving tabindex），模型与运行状态走 `aria-live="polite"`。
- **画布生命周期**：`ocr-client.tsx` 上传/粘贴后把原始 ImageData 存 ref，工作区 canvas 由 effect 按 `imageVersion` 重绘；标注框叠加在 canvas 上，切换模型或换图时回画原始 ImageData。`重新识别` 复用 ref 中的 ImageData，不重复解码。

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

- 前端逻辑：`pnpm lint`；触及类型时再 `pnpm exec tsc --noEmit`；manifest/runtime 行为跑 `pnpm test`。
- 流水线回归：有模型时跑 `python3 scripts/verify_pipeline.py --model <id>`（三档各跑一次，Tiny 加 `--baseline`）；浏览器路径用 `pnpm dev` 加载清单并实测识别。
- 发布前：`pnpm build`，确认 `out/` 含页面与 `/ort`、`/models.json`（`public/models/<id>/` 下各档权重与字典需另行放到服务器）。
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
