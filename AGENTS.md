# OCR 功能研究验证

本项目研究一些高可用、低消耗、识别能力强的小模型。

并且考虑 onnx 客户端运行的方式。



1. 探究小模型 OCR，效果不错的，可以是依赖 GPU 的
2. 探究不依赖 GPU，而是 CPU 可运行的，比如本地机器和服务器 vps
3. 探究客户端可用的方式和模型运行方式，比如 web、app


<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
