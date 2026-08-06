# 浏览器端 OCR 验证站 — 产品逻辑与实施计划

> 2026-08-06 经 `/think` 梳理确认。本文档是网站功能的定稿方案，实施前请通读。

> **2026-08-06 状态更新**：Phase 1 静态草稿（`web/`）已完成并验证。随后产品形态决策变更——`web/` 降级为验证草稿，正式产品改用 **Next.js 16.3 + Tailwind v4** 实现，位于 `ocr-web/`，技术依据见 `docs/nextjs-tailwind-research.md`。部署模型不变：`next build` 静态导出 `out/` → rsync + nginx + Cloudflare。本文档的产品逻辑（清单驱动、Cache API、后端回退、模型生命周期）在 Next.js 版中全部沿用。

## 一、产品定位

一个公开可访问的「浏览器端 OCR 验证站」：像真实产品一样选模型、加载、识别，但**所有推理在访客自己机器上完成**（onnxruntime-web），服务器只做静态文件分发。

## 二、核心闭环（用户主路径）

```
选模型（默认推荐项已选中）
  → 加载模型（进度条 + 浏览器缓存，下过则秒开）
  → 传图（拖拽/点击）
  → 识别（检测 → 识别 → CTC 解码，显示进度）
  → 看结果（逐行文本 + 置信度 + 图上标注框 + 耗时/推理后端）
```

## 三、模型生命周期（产品的"商品管理"逻辑）

- 每个模型是 `web/models.json` 里的一条清单记录：名称、大小、语言、推荐标记、文件地址、流水线类型、推理参数。
- `source: local` 的模型（当前仅 PP-OCRv6 tiny，约 6MB）随站点部署，走自有服务器 + Cloudflare CDN 边缘缓存。
- `source: remote` 的模型（后续大模型）浏览器**直连 HuggingFace CDN** 下载，零字节经过自有服务器。
  - 已实测（2026-08-06）：HF `resolve` 两跳均带 CORS 头（最终 CDN 节点 `Access-Control-Allow-Origin: *`），且带 `content-length` 可显示下载进度。
  - ModelScope 的 CORS 未验证，清单暂只收 HF / jsdelivr 源。
- 两种来源统一走 **Cache API** 持久化：下载一次后离线可用。

## 四、技术方案

### 4.1 结构（零构建，原生 ES modules）

```
web/
├── index.html          # 布局 + 样式（沿用现有暗色 UI）
├── models.json         # 模型注册表（唯一需要维护的清单）
├── js/
│   ├── app.js          # 入口：读清单、渲染模型选择器、串联事件
│   ├── loader.js       # 模型下载（fetch 流式进度）+ Cache API 缓存
│   └── ppocr.js        # PP-OCR 流水线（从现有 index.html 抽出）
├── ppocr_keys_v6_tiny.json
└── models/             # local 模型（tiny 两个 onnx）
```

### 4.2 models.json schema

```json
{
  "id": "ppocrv6-tiny",
  "name": "PP-OCRv6 Tiny",
  "recommended": true,
  "sizeMB": 6.2,
  "desc": "中英等 49 种语言，6MB，秒载",
  "source": "local",
  "pipeline": "ppocr-dbnet-ctc",
  "files": {
    "det": "models/PP-OCRv6_det_tiny.onnx",
    "rec": "models/PP-OCRv6_rec_tiny.onnx",
    "dict": "ppocr_keys_v6_tiny.json"
  },
  "params": { "detMaxSide": 960, "recHeight": 48, "recMaxWidth": 3200, "dictSize": 6906 }
}
```

`pipeline` 字段是关键扩展点：v1 只实现 `ppocr-dbnet-ctc`；以后接 small（轮廓检测后处理）或其他架构时，新增 pipeline 模块、清单指过去即可，不动现有代码。

### 4.3 数据流（三个模块，无循环依赖）

```
models.json ──> app.js（渲染选择器）
                  │ 用户选定
                  ▼
              loader.js（cache 命中？ → 否：fetch 流式下载+进度 → 写 Cache API）
                  │ ArrayBuffer
                  ▼
              ppocr.js（ort session + 推理 + 后处理）──> 结果回 app.js 渲染
```

### 4.4 UI 增量

在现有 `web/index.html` 基础上加两块：

1. 头部**模型选择器**：显示名称 / 大小 / 推荐徽标 / 加载状态，默认选中 `recommended` 项。
2. **模型加载进度条**（按 content-length 流式汇报）。

识别交互逻辑完全沿用现有实现；识别完成后结果区显示实际推理后端（webgpu/webgl/wasm）和耗时——这是验证站的核心数据。

## 五、关键决策

1. **JSON 清单驱动**：UI、加载逻辑全部读清单，代码中不写死模型信息。
2. **远程模型直连 HuggingFace**：CORS 已实测通过；v1 清单只允许 HF / jsdelivr 源。
3. **Cache API 而非 IndexedDB 存模型**：`caches.open('ocr-models-v1')` 按 URL 缓存 Response；加载时先查缓存再下载；下载大模型前用 `navigator.storage.estimate` 检查配额。
4. **部署 = rsync + Cloudflare 反代**：见 Phase 2。注意此路径用 CF 仪表盘/DNS，**wrangler 用不上**；wrangler 对应备选方案 Cloudflare Pages（直接托管在 CF，服务器都不需要，单文件上限 25MiB），以后嫌维护服务器麻烦可切换。
5. **推理后端回退保留**：现有 `webgpu → webgl → wasm` 逻辑不变。

## 六、实施 Phases（各自可独立交付）

### Phase 1 — registry 驱动重构（v1 功能）

1. 新建 `web/models.json`，写入 tiny 一条记录
2. 抽 `web/js/ppocr.js`：现有 index.html 的预处理 / DBNet / CTC / 推理代码原样搬出，导出 `createPipeline(modelEntry)` 与 `run(imageData)`
3. 新建 `web/js/loader.js`：`loadModel(entry, onProgress)` = Cache API 查询 → 流式 fetch（`response.body.getReader()` 按 content-length 报进度）→ 写缓存 → 返回 ArrayBuffer
4. 新建 `web/js/app.js`：读清单、渲染选择器、默认选中 recommended、串联上传/识别/结果渲染
5. 重写 `web/index.html`：保留现有样式，头部加模型选择区和加载进度条，body 只留 `<script type="module" src="js/app.js">`
6. 验证：
   - `cd web && python3 -m http.server 3001`，用 `test_input.png` 跑通全流程
   - DevTools Network 确认二次加载时 onnx 来自 Cache Storage
   - 断网刷新仍可用（模型已缓存）

### Phase 2 — 部署上线

1. `rsync -avz --delete web/ claw:~/ocr-web/`
2. 服务器 nginx 站点配置：root 指向该目录，gzip on；
   `location ~* \.onnx$ { add_header Cache-Control "public, max-age=2592000"; }`
3. Cloudflare 接入域名（NS 切到 CF 或已有域加子域），开橙色云代理
4. CF Cache Rules：`*.onnx` 与 `*.json` Edge TTL 30 天
5. 验证：
   - 外网访问跑通全流程
   - `curl -I` 确认 onnx 二次请求有 `cf-cache-status: HIT`
   - 服务器访问日志确认模型流量由 CF 边缘承担

## 七、v1 明确不做（Not building）

- 多模型对比模式
- 批量识别、结果导出
- Service Worker 全站离线（Cache API 只缓存模型文件）
- small/medium 模型接入（清单和 pipeline 字段已留口，代码不写）
- 构建工具（无 vite/bun build）

## 八、Unknowns 与风险

- **域名**：CF 反代需要托管在 Cloudflare 的域名。若没有，Phase 2 退化为纯 IP+端口访问（CF 部分跳过），不影响 Phase 1。owner：本站维护者，部署前确认。
- **HF CORS 策略持续性**（最脆弱假设）：今天实测通过，若 HF 收紧，远程模型加载会失败。免疫设计：清单改 `source: local` 或走 CF Worker 代理即可降级，不动产品代码。
- **回滚**：全部为静态文件，无数据状态。任何问题 `git checkout` 恢复旧 `index.html`，或服务器指回旧目录。重构期间旧文件保留到新版验证通过后再替换。
