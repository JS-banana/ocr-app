# OCR-APP — 浏览器端 OCR 验证站

基于 **PP-OCRv6 tiny（约 6MB）+ onnxruntime-web** 的纯浏览器端 OCR：选模型、加载、识别全在访客自己机器上完成，服务器只做静态文件分发。

技术栈：**Next.js 16（静态导出）+ Tailwind CSS v4 + TypeScript**，部署形态为纯静态站（nginx + Cloudflare）。

## 快速开始

```bash
npm install        # 安装依赖（postinstall 自动拷 ort wasm 到 public/ort/）
npm run dev        # 开发：http://localhost:3000
npm run build      # 构建：静态导出到 out/，任意静态服务器可分发
```

模型文件（`public/models/*.onnx`）不纳入 git，首次或缺失时下载：

```bash
bash scripts/download_models.sh      # 默认走 hf-mirror 加速
```

## 目录结构

```
├── app/                     # Next.js App Router（layout / page / globals）
├── components/ocr-client.tsx  # OCR 客户端 UI（模型选择/上传/识别/结果）
├── lib/ocr/                 # 推理流水线与模型加载
│   ├── ppocr.ts             #   DBNet 检测 + CTC 识别（webgpu→webgl→wasm 回退）
│   ├── loader.ts            #   Cache API 持久化 + 流式下载进度
│   └── types.ts
├── public/
│   ├── models.json          # 模型清单（唯一需要维护的注册表）
│   ├── models/              # onnx 模型 + 字符集（git 忽略）
│   └── ort/                 # ort wasm 运行时（postinstall 生成）
├── docs/                    # 产品方案、技术调研、源资料
├── scripts/                 # 研究工具链（下载模型 / Python 验证 / 字符集提取）
│   └── assets/test_input.png
└── out/                     # next build 静态导出产物（rsync 分发）
```

## 产品逻辑

- **清单驱动**：`public/models.json` 每条记录描述一个模型（名称/大小/来源/pipeline 类型/推理参数），UI 与加载逻辑全部读清单，代码不写死模型信息
- **模型缓存**：下载走 Cache API（`ocr-models-v1`），一次下载离线可用
- **推理后端**：`webgpu → webgl → wasm` 自动回退，识别完成后显示实际后端与耗时
- 详见 `docs/web-playground-plan.md`（产品定稿方案）与 `docs/nextjs-tailwind-research.md`（技术选型依据）

## 部署

```bash
npm run build                          # 产物在 out/
rsync -avz --delete out/ server:~/ocr-web/
```

nginx/Cloudflare 缓存配置（`.onnx`/`.wasm` 长缓存、`.html` 每次验证）见 `docs/nextjs-tailwind-research.md` 第四节。

## 研究工具链（scripts/）

```bash
bash scripts/download_models.sh        # 下载模型到 public/models/
python3 scripts/verify_pipeline.py     # Python 端到端验证（无需浏览器）
python3 scripts/extract_charset.py     # 从官方 inference.yml 提取字符集（模型升级时用）
```

## 关键经验（实测）

1. **字符集必须与模型匹配**：官方 `inference.yml` 内嵌 6904 字符，外部 6622 字典会全乱码
2. **softmax 防 NaN**：模型输出含 NaN 时 `Math.exp(NaN)` 会整行扩散，需 `isFinite` 防护
3. **det 输出单通道** `[N,1,H,W]`，概率图分辨率与输入一致
4. **ort wasm 资产需整套拷贝**：`ort-wasm-simd-threaded.*`（mjs+wasm 全家族），jsep 工作线程依赖 `.mjs` 伴侣文件
5. **`onnxruntime-web` 需全量主入口导入**：`/webgpu` 条件导入不含 webgl 后端，而 webgl 是 iOS/Safari 唯一 GPU 兜底

## 参考

- PP-OCRv6 tiny 模型：https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx 、https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx （Apache-2.0）
- PaddleOCR 官方：https://github.com/PaddlePaddle/PaddleOCR
- onnxruntime-web：https://github.com/microsoft/onnxruntime
- 方案来源整理：`docs/wechat-paddleocr-onnx-browser.md`
