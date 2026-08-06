# Next.js + Tailwind CSS + onnxruntime-web 技术调研报告

调研日期：2026-08-06。所有版本号均经 npm registry / 官方文档 / GitHub 实地核实，非凭记忆。
项目背景：web/ 目录零构建静态草稿已验证可行（PP-OCRv6 tiny onnx 约 6MB、onnxruntime-web CDN 加载、Cache API 缓存模型、webgpu→webgl→wasm 回退、全客户端推理），正式产品决定用 Next.js + Tailwind CSS 重构，部署要求保持"纯静态站 + nginx/Cloudflare 分发"模型。

---

## 一、Next.js 与 Tailwind CSS 当前稳定版及脚手架集成方式

### 结论

| 项目 | 结论 |
|---|---|
| Next.js 最新稳定版 | **16.3.0**（npm `latest` tag，2026-08-06 实地核实） |
| Tailwind CSS 最新稳定版 | **4.3.3**（`tailwindcss` 与 `@tailwindcss/postcss` 同版本发布） |
| App Router | **仍是默认**。create-next-app 默认启用 TypeScript + Tailwind + ESLint + App Router + Turbopack |
| Tailwind 集成方式 | Tailwind v4 的 **`@tailwindcss/postcss`** PostCSS 插件（不再是 v3 的 `tailwindcss` 直接作插件） |
| CSS 入口 | **`@import "tailwindcss";`** 一行导入；旧的 `@tailwind base/components/utilities` 指令已废弃 |
| tailwind.config.js | **不再生成也不需要**，v4 为 CSS-first 配置（`@theme` 指令） |

脚手架命令（官方默认即所得）：

```bash
npx create-next-app@latest   # 默认 = TS + Tailwind + App Router + Turbopack
```

官方模板三个关键文件（create-next-app canary 模板实地核实）：

```js
// postcss.config.mjs
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
export default config;
```

```css
/* app/globals.css 开头即 */
@import "tailwindcss";
/* 主题定制走 @theme { --color-... } 指令，无 tailwind.config.js */
```

注意：`next dev` 默认走 Turbopack，需 webpack 时用 `next dev --webpack`。Tailwind v4 是纯构建时方案，产物为普通静态 CSS，与纯静态分发完全兼容；v4 目标现代浏览器（Safari 16.4+），与 Next.js 16 浏览器基线一致。

### 来源

- https://registry.npmjs.org/next/latest → 16.3.0
- https://registry.npmjs.org/tailwindcss/latest → 4.3.3
- https://registry.npmjs.org/@tailwindcss/postcss/latest → 4.3.3
- https://nextjs.org/docs/app/getting-started/installation （create-next-app 默认项、Turbopack 默认）
- https://tailwindcss.com/docs/installation/framework-guides/nextjs （官方 Next.js 集成五步法）
- https://nextjs.org/docs/app/guides/tailwind-css
- https://tailwindcss.com/docs/theme （v4 CSS-first `@theme` 配置）
- https://raw.githubusercontent.com/vercel/next.js/canary/packages/create-next-app/templates/app-tw/ts/postcss.config.mjs （模板原文；同目录 tailwind.config.js/ts 实测 404 不存在）

---

## 二、onnxruntime-web 在 Next.js 中的接入：官方推荐与已知坑

### 结论

1. **版本**：npm `onnxruntime-web` latest = **1.27.0**（2026-06-19 发布）。GitHub 有更新的 v1.27.1/v1.28.0 tag，但 npm latest 仍是 1.27.0。锁定 `onnxruntime-web@1.27.0`。
2. **npm 导入，不用 CDN script**。bundler 场景官方主路径是 `import * as ort from 'onnxruntime-web'`；要 WebGPU 用 `import * as ort from 'onnxruntime-web/webgpu'`（条件导入，减小 JS 体积）。CDN script 标签只面向无构建器的简单页面。
3. **wasm 资产：拷到 `public/` + 显式 `wasmPaths`**。wasm 二进制不内嵌在 JS bundle 里（1.27.0 的 `ort.bundle.min.mjs` 仅 405KB，wasm 为外部文件 13.5MB~26.8MB）。只需拷用到的文件：wasm 后端用 `ort-wasm-simd-threaded.wasm`，WebGPU/WebNN 还必须拷 `ort-wasm-simd-threaded.jsep.wasm`（官方原话 "Just 2 .wasm files, copy the one you use"）。
   ```ts
   ort.env.wasm.wasmPaths = '/ort/';  // 指向 public/ort/，静态站建议绝对路径
   ```
4. **后端回退链**：`executionProviders: ['webgpu', 'webgl', 'wasm']` 与官方兼容矩阵一致。WebGPU 在 iOS/Safari/Firefox 全部 ❌ 且仍为 experimental；WebGL 已进入维护模式但是唯一覆盖 iOS/Safari 的 GPU 后端——webgl 层必须保留兜底。
5. **'use client' + `ssr: false` 是必要的**。onnxruntime-web 的 package.json exports 对 node 显式禁用，RSC/SSR 解析到 import 语句会在**构建期**直接失败（不是运行时报错）。官方维护者（fs-eire）确认的写法：只在 CSR module 中 import；官方 e2e 测试（`js/web/test/e2e/exports/testcases/nextjs-default`）就是 `'use client'` + `next/dynamic(..., { ssr: false })` + 空 next.config。
6. **wasm 多线程需跨源隔离**（COOP/COEP header），否则自动退化单线程；`ort.env.wasm.numThreads` 默认自动（`min(hardwareConcurrency/2, 4)`）。
7. **大模型缓存**：官方文档明确建议用 **Cache API** 或 IndexedDB 缓存模型文件——与现有草稿方案一致，继续沿用。

### 历史坑位（在当前版本组合下均已修复，勿抄旧教程）

- **webpack 重写 `import.meta.url` 导致 wasm/worker 404**（microsoft/onnxruntime#22113）：官方 PR #23257 于 1.21.0 起修复。旧的 `parser: { javascript: { importMeta: false } }` workaround 在 Next.js 下不可用，别再抄。
- **Turbopack blob-URL worker 内 wasm fetch 失败**（vercel/next.js#84782，microsoft/onnxruntime#25096）：Next 16.1.x 已修复，ORT 侧 PR #27411（2026-02 合并）双保险，1.27.0 必然包含。
- **1.19.0 wasm 文件名变更**（#21811）：CopyPlugin glob 时代终结，官方 TL;DR 即"按用到的 EP 拷对应那一个 wasm 文件"。
- **Turbopack 下 next.config 的 `webpack()` 配置整体被忽略**（官方文档 "Known gaps"）：老教程的 copy-webpack-plugin / resolve.fallback 方案已失效且无必要——官方 e2e 用**空配置**跑通 `next dev` 和 `next build` 双模式。
- **vercel/next.js#92356**（open）：Vercel 部署 `?dpl=` 后缀双重编码致 wasm 404——仅影响 Vercel 托管，与 nginx/CF 静态分发无关。
- `onnxruntime-node` 已在 Next.js 默认 `serverExternalPackages` 列表中（若未来做服务端推理零配置）；`onnxruntime-web` 不在也不该在。

### 来源

- https://registry.npmjs.org/onnxruntime-web （dist-tags、发布时间线）
- https://onnxruntime.ai/docs/get-started/with-javascript/web.html （导入方式、条件导入、EP 兼容矩阵）
- https://onnxruntime.ai/docs/tutorials/web/deploy.html （部署资产、wasmPaths、CDN 约束）
- https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html （WebGPU 要求、浏览器矩阵）
- https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html （env.wasm.*、executionProviders、crossOriginIsolated）
- https://onnxruntime.ai/docs/tutorials/web/large-models.html （Cache API 缓存模型）
- https://github.com/microsoft/onnxruntime/tree/main/js/web/test/e2e/exports/testcases/nextjs-default （官方 e2e：空 next.config + 'use client' + ssr:false）
- https://github.com/microsoft/onnxruntime/issues/23449 （维护者：只在 CSR module import onnxruntime-web）
- https://github.com/microsoft/onnxruntime/issues/17274 （'use client' 修复 Next.js 初始化报错）
- https://github.com/microsoft/onnxruntime/issues/22113 + https://github.com/microsoft/onnxruntime/pull/23257 （import.meta.url 修复）
- https://github.com/microsoft/onnxruntime/issues/21811 （wasm 文件官方 TL;DR、禁 SSR）
- https://github.com/microsoft/onnxruntime/issues/25096 + https://github.com/microsoft/onnxruntime/pull/27411 （Turbopack worker 修复）
- https://github.com/vercel/next.js/issues/70296 （exports node 条件解析）
- https://github.com/vercel/next.js/issues/84782 （closed）、https://github.com/vercel/next.js/issues/92356 （open，仅 Vercel）
- https://nextjs.org/docs/app/api-reference/turbopack （webpack() 配置不识别）
- https://nextjs.org/docs/app/guides/lazy-loading （ssr:false 只允许在 Client Component）

---

## 三、Next.js 静态导出（output: 'export'）现状与限制

### 结论

**可以保持"纯静态站 + nginx/Cloudflare 分发"模型**，`output: 'export'` 在 Next 16.3.0 下是官方一等支持的能力：

```ts
// next.config.ts
import type { NextConfig } from 'next';
const nextConfig: NextConfig = { output: 'export' };
export default nextConfig;
```

- 构建命令就是普通的 **`next build`**（`next export` 命令 v14 已删除），产出 `out/` 目录：`out/index.html`、`out/404.html`、`out/<route>/...html`、`out/_next/static/`（带构建哈希的 JS/CSS chunk）、`public/` 原样拷贝的文件。
- 官方文档明确：out/ "can be deployed and hosted on any web server that can serve HTML/CSS/JS static assets"，并直接给出 nginx 配置示例（`try_files $uri $uri.html $uri/ =404`）。
- 建议开 `trailingSlash: true` 生成 `<route>/index.html` 结构，nginx/静态主机映射更省心。

### 静态导出不可用功能（官方 Unsupported Features 清单，共 13 条）

Dynamic Routes（`dynamicParams: true` 或无 `generateStaticParams()`）、**依赖 Request 的 Route Handlers**（只有不读 Request 的 GET Route Handler 可用，build 时渲染成静态文件）、**Cookies/headers() 等动态 API**、**next.config 的 Rewrites / Redirects / Headers**、**Proxy（原 Middleware，Next 16 已改名）**、**ISR**、**默认 loader 的 Image Optimization**、Draft Mode、**Server Actions**、Intercepting Routes。

对本项目（全客户端推理、无服务端逻辑）几乎无影响——砍掉的全是服务端能力。唯二要注意：

1. **next/image**：工具站图片主要是用户本地上传（不走优化管线），直接全局 `images: { unoptimized: true }` 最省事；若未来要 CDN 图片优化，用 `loader: 'custom' + loaderFile`（官方文档含 Cloudflare loader 示例）。
2. **预渲染期无浏览器 API**：`output: 'export'` 下 Client Component 仍会在 `next build` 被预渲染成 HTML，`window`/`localStorage`/ort 推理调用必须放 `useEffect`/事件回调或 `ssr: false` 的 dynamic import 内。

静态导出路径仍在活跃维护（实证：issue #92187 16.2.0 router cache 回归已修；#92339 Windows 路径问题 open，团队有 Windows 开发机需留意）。

### 来源

- https://nextjs.org/docs/app/guides/static-exports （主文档，v16.3.0，含 nginx 示例与 Unsupported Features 清单）
- https://github.com/vercel/next.js/discussions/58790 （`next export` 移除公告）
- https://nextjs.org/docs/app/api-reference/config/next-config-js/images
- https://nextjs.org/docs/app/api-reference/components/image （unoptimized）
- https://nextjs.org/docs/app/api-reference/file-conventions/proxy （middleware→proxy 改名）
- https://github.com/vercel/next.js/issues/92187 （closed）、https://github.com/vercel/next.js/issues/92339 （open）

---

## 四、public/ 分发 6MB .onnx 模型与长缓存 header

### 结论

1. **6MB `.onnx` 放 `public/models/` 直接分发是合适的**，官方无任何文件大小限制条款。访问路径 `/models/PP-OCRv6_det_tiny.onnx`，导出后位于 `out/models/`。
2. **缓存头必须在分发层（nginx/CF）自己配**。两层原因：
   - Next.js 伺服时 public 文件默认 `Cache-Control: public, max-age=0`（官方原话 "cannot safely cache assets in the public folder"）；
   - `output: 'export'` 下 Next.js 完全不参与运行时响应，且 `next.config` 的 `headers()` 名列 Unsupported Features——框架层没有任何机会下发缓存头。
3. **文件名即版本号即缓存策略**：public 资产无内容哈希，但本项目模型文件名自带版本（`PP-OCRv6_*_tiny.onnx`），升级即换名，等价于 immutable，可放心给长缓存。再叠加客户端已有的 Cache API 持久化，三层机制齐备。
4. **参照基准**：Next.js 给带哈希资产（`/_next/static`）的官方头值是 `Cache-Control: public, max-age=31536000, immutable`，照抄到 nginx/CF 配置即可。
5. 重要提醒：`.onnx` 和 `.wasm` **都不在 Cloudflare 默认缓存扩展名列表里**，必须显式建 Cache Rule（或由源站发 `Cache-Control: public, max-age>0`，CF 默认尊重源站头）。

### nginx 层做法（在官方导出示例上扩展）

```nginx
server {
  listen 80;
  server_name ocr.example.com;
  root /var/www/out;

  # 构建产物：文件名带哈希，一年 immutable
  location /_next/static/ {
      add_header Cache-Control "public, max-age=31536000, immutable";
      try_files $uri =404;
  }

  # 模型与 wasm：文件名带版本号，长缓存
  location ~* \.(onnx|wasm)$ {
      add_header Cache-Control "public, max-age=2592000";  # 30 天
      try_files $uri =404;
  }

  # HTML：每次验证，发版即生效
  location / {
      add_header Cache-Control "public, max-age=0, must-revalidate";
      try_files $uri $uri.html $uri/ =404;
  }

  error_page 404 /404.html;
  location = /404.html { internal; }
}
```

### Cloudflare 层做法（免费档各 10 条规则）

- **Cache Rules**：匹配 `/models/*` 或按扩展名 → Eligible for cache + Edge TTL `override_origin`（如 1 个月）；`/_next/static/` 同理设 1 年。用于边缘缓存 `.onnx`/`.wasm` 这类非默认扩展名。
- **Response Header Transform Rules**：可不经源站、直接在边缘给 `/models/*.onnx` 响应 set `Cache-Control`。
- 也可用 `CDN-Cache-Control` 细分头让 CDN 与浏览器用不同 TTL（通用标准，CF/Vercel 都支持）。

### 来源

- https://nextjs.org/docs/app/api-reference/file-conventions/public-folder （public 默认 max-age=0 原文）
- https://nextjs.org/docs/app/guides/self-hosting （immutable 头基准值）
- https://nextjs.org/docs/app/guides/static-exports （Headers 在 Unsupported Features 清单）
- https://vercel.com/docs/edge-network/caching （CDN-Cache-Control、Vercel CDN 10MB 可缓存上限）
- https://developers.cloudflare.com/cache/how-to/cache-rules/
- https://developers.cloudflare.com/cache/concepts/default-cache-behavior/ （默认扩展名列表不含 onnx/wasm）
- https://developers.cloudflare.com/rules/transform/

---

## 五、部署选型：静态导出 + 自有服务器 vs Vercel

### 结论

**推荐：`output: 'export'` + rsync 原子发布 + nginx + Cloudflare（免费档）。Vercel 不作为主部署，可留作海外预览/备用。**

理由按权重排序：

1. **国内可达性是决定性因素**。Vercel 官方 KB 明确承认：大陆无基础设施、`.vercel.app` 可能被 GFW 阻断、"无法保证中国大陆的可用性或性能"，官方建议即"自定义域名 + 自建静态镜像/双部署"。自有方案可自选 VPS 线路、未来无缝加国内镜像。
2. **带宽账本不划算**。Vercel Hobby 档 Fast Data Transfer 仅 **100 GB/月**、Edge Requests 100 万次/月，超额后无按需付费通道、要等 30 天恢复。本场景单用户首次加载 ~6MB 模型 + wasm 运行时（10–20MB），100GB 约只够 3–8 千次冷首次访问/月。Cloudflare 免费档代理流量不计费，源站只剩回源流量。
3. **Hobby 档禁止商用**（Fair Use Guidelines：non-commercial, personal use only）。正式产品有商业属性即需 Pro（$20/seat/月）。
4. **缓存控制两者等价甚至自有更自由**：静态导出下 `headers()` 不可用，Vercel 侧也只能用平台默认静态缓存行为（且官方明确 "does not allow bypassing the cache for static files by design"）；而 nginx + CF Cache Rules 可对 `/models/*.onnx` 精确设定 TTL。
5. Vercel 唯一明显优势是 **Instant Rollback + 零运维**（Hobby 仅可回滚上一部署），但 `releases/<sha>/` + symlink 切换可等价实现秒级原子发布与任意版本回滚，代价是一个 10 行部署脚本。

### 执行要点

```bash
# 原子发布 + 秒级回滚
rsync -a --delete out/ server:/srv/ocr/releases/<git-sha>/ \
  && ssh server 'ln -sfn /srv/ocr/releases/<git-sha> /srv/ocr/current'
```

nginx 根目录指 `current` symlink；回滚 = 重指 symlink。

### 来源

- https://vercel.com/pricing 、https://vercel.com/docs/pricing （Hobby 100GB/1M 额度、Pro 条款）
- https://vercel.com/docs/accounts/plans/hobby （非商用限制、超额等 30 天）
- https://vercel.com/docs/edge-network/caching （静态缓存不可 bypass）
- https://vercel.com/docs/instant-rollback
- https://vercel.com/kb/guide/accessing-vercel-hosted-sites-from-mainland-china （大陆可达性官方 KB）
- https://developers.cloudflare.com/cache/how-to/cache-rules/ 及 settings 子页
- https://nextjs.org/docs/app/guides/static-exports

---

## 六、落地建议

### 脚手架

```bash
npx create-next-app@latest ocr-web --typescript --tailwind --eslint --app --turbopack
cd ocr-web
npm install onnxruntime-web@1.27.0
```

### 建议目录结构

```
ocr-web/
├── next.config.ts            # 仅 { output: 'export', images: { unoptimized: true } }，勿加 webpack()
├── postcss.config.mjs        # 模板自带 @tailwindcss/postcss，不动
├── app/
│   ├── globals.css           # @import "tailwindcss"; 开头
│   ├── layout.tsx
│   └── page.tsx              # 'use client' + dynamic(OcrClient, { ssr: false })
├── components/
│   └── ocr-client.tsx        # 全部 ort 逻辑在此，InferenceSession.create() 放 useEffect/事件回调
├── lib/
│   └── ocr/                  # 从 web/js 迁移的预处理/后处理/字典加载逻辑（纯函数，无浏览器 API 可被安全 import）
├── public/
│   ├── models/               # PP-OCRv6_det_tiny.onnx、PP-OCRv6_rec_tiny.onnx、ppocr_keys_v6_tiny.json
│   └── ort/                  # ort-wasm-simd-threaded.wasm + ort-wasm-simd-threaded.jsep.wasm（构建脚本从 node_modules 拷入）
└── out/                      # next build 产物，rsync 分发
```

wasm 拷贝建议做成 npm script（版本号随包升级自动跟上）：

```json
"scripts": {
  "prebuild": "cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm public/ort/",
  "build": "next build"
}
```

推理初始化核心写法：

```ts
// components/ocr-client.tsx（'use client' 组件内）
import * as ort from 'onnxruntime-web/webgpu';

ort.env.wasm.wasmPaths = '/ort/';
const session = await ort.InferenceSession.create('/models/PP-OCRv6_rec_tiny.onnx', {
  executionProviders: ['webgpu', 'webgl', 'wasm'],
});
```

### 坑位规避清单（按踩坑概率排序）

1. **不要在服务端模块 import onnxruntime-web**——exports 对 node 显式禁用，构建期即炸。推理组件必须 `'use client'` + `next/dynamic(..., { ssr: false })`，且 `ssr: false` 只能写在 Client Component 里。
2. **不要在组件函数体顶层调用 ort / window / localStorage**——静态导出下 Client Component 也会被 `next build` 预渲染成 HTML，浏览器 API 只能出现在 `useEffect`/事件回调里。
3. **不要在 next.config 里写 `webpack()` 配置**（CopyPlugin、resolve.fallback、externals）——Turbopack 下整体被忽略；2024 年的 onnxruntime+Next.js 教程全部过时，当前版本组合下官方 e2e 用空配置跑通。
4. **不要指望 `headers()` 配缓存**——静态导出不生效，缓存头全部在 nginx/CF 层做；`.onnx`/`.wasm` 不在 CF 默认缓存扩展名里，必须显式建 Cache Rule。
5. **不要用默认 next/image loader**——静态导出不支持，直接 `images: { unoptimized: true }`。
6. **wasm 文件名别照抄旧教程**——1.19 后只剩 `ort-wasm-simd-threaded.wasm`（CPU）和 `ort-wasm-simd-threaded.jsep.wasm`（WebGPU/WebNN 必需），拷自己用到的那一个/两个即可；`wasmPaths` 用绝对路径。
7. **Vercel 部署有 wasm 404 残留 issue（#92356，?dpl= 双重编码）**——再次印证主部署走自有 nginx/CF。
8. **webgl 回退层不能删**——WebGPU 不覆盖 iOS/Safari/Firefox，WebGL 虽处维护模式但是唯一全平台 GPU 后端。
9. **wasm 多线程需要 COOP/COEP**（`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`），在 nginx/CF 层加；不加则自动单线程，不影响功能。注意加 COEP 后所有跨源资源（含 CDN 字体等）需带 CORP 头，静态站自用资源无此问题。
10. **模型文件改名即发版**：public 资产无内容哈希，模型更新必须换文件名（版本号递增），否则长缓存用户拿不到新模型。

---

## 关键版本号速查（2026-08-06 核实）

| 包 | 版本 | 来源 |
|---|---|---|
| next | 16.3.0 | registry.npmjs.org/next/latest |
| tailwindcss | 4.3.3 | registry.npmjs.org/tailwindcss/latest |
| @tailwindcss/postcss | 4.3.3 | registry.npmjs.org/@tailwindcss/postcss/latest |
| onnxruntime-web | 1.27.0 | registry.npmjs.org/onnxruntime-web（latest tag；GitHub 已有 v1.28.0 tag 但 npm 未跟上） |
