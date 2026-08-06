# 网页端 OCR：加载 6MB 大小模型，又快又准

> **来源**：微信公众号文章
> **原文链接**：https://mp.weixin.qq.com/s/tggpTBdbHY9CXz5P3L3Leg
> **主题**：使用 PP-OCRv6 tiny（约 6MB）+ onnxruntime-web，在浏览器端纯前端实现 OCR，无需后端服务
> **核心结论**：图片不上传服务器，全部在浏览器本地跑，离线也能用

---

## 背景思路

作者想给内部系统加 OCR 功能（用户上传截图自动识别文字），发现百度的 PaddleOCR —— 专用 OCR 模型，识别率比大模型优秀。

**传统做法**：后端起 Python 服务，装 PaddleOCR，部署 Flask。麻烦不说，还得考虑并发和资源占用。

**新的思路**：让浏览器自己干这事儿 —— 用 onnxruntime-web 把模型跑在浏览器里。

---

## 1. onnxruntime-web 是什么

ONNX Runtime 是微软开源的推理引擎，onnxruntime-web 是它的浏览器版本。

底层用 **WebGL 或 WebGPU**，让显卡在浏览器里给 AI 打工。

### 接入方式

```bash
# npm
npm install onnxruntime-web

# bun
bun add onnxruntime-web
```

安装后创建 `src/index.ts` 作为入口：

```ts
import * as ort from 'onnxruntime-web';
ort.env.wasm.wasmPaths = '/ort/';
(window as any).ort = ort;
```

用构建工具打包到静态目录：

```bash
# bun
bun build ./src/index.ts --outfile=./static/ort.js --target=browser

# 或用 webpack / vite 都行
```

HTML 里引用打包产物：

```html
<script src="ort.js"></script>
```

> 加载模型、准备输入、推理、拿结果，四步完成，没有服务端，全在浏览器。

---

## 2. 下载模型

PP-OCRv6 的 ONNX 模型用魔塔 **ModelScope** 下载，国内速度快。

在魔搭上搜索 `PP-OCRv6_tiny`，然后下载对应的 onnx 文件。

### 两个模型文件的作用

**PP-OCRv6_tiny_det_onnx：文本检测模型**
- 核心功能：在图像中精确定位并标记所有文本区域的位置，用边界框（Bounding Boxes）圈出
- 主要特点：tiny（微型）系列，专为端侧和 IoT 场景设计，追求极致轻量和高速。参数量仅 **43 万（0.43M）**，大小约 **1.9 MB**
- 应用场景：擅长处理手写、印刷、旋转、弯曲和艺术字体等多种复杂场景的文字

**PP-OCRv6_tiny_rec_onnx：文本识别模型**
- 核心功能：接收检测模型给出的文本区域图像，将视觉信息转化为可编辑、可搜索的电子文本
- 主要特点：PP-OCRv6 中最轻量的识别模型。参数量 **110 万（1.1M）**，大小约 **4.4 MB**，支持 **49 种语言**识别
- 应用场景：高效识别简中、繁中、英文、日文等，能处理手写、竖排、拼音、生僻字等复杂文本

### 模型目录结构

```
static/
  models/
    PP-OCRv6_det_tiny.onnx
    PP-OCRv6_rec_tiny.onnx
```

---

## 3. OCR 流水线

OCR 不是单一模型，是**文本检测 + 文本识别**两个模型串联。

PP-OCRv6 有 tiny、small、medium 三个尺寸。

```
上传图片
  → 缩放至 960 以内（32 倍数）
  → 检测模型推理，得到概率图
  → 后处理：二值化 → 连通域 → 文本框
  → 对每个文本框裁剪
  → 缩放至 48xW
  → 识别模型推理
  → CTC 解码 → 得到文字
```

> tiny 版本检测模型 1.74 MB，识别模型 4.28 MB，加起来 **6 MB 多**，浏览器加载很快。

---

## 4. 图像预处理

检测模型需要特定尺寸的输入：**长边不超过 960，且必须是 32 的倍数**。

**为什么是 32？** 因为模型内部有步长为 32 的下采样层，输入尺寸不是 32 的倍数会导致输出截断。

> 预处理三件事：缩放、RGB→CHW 通道顺序、归一化。参数来自官方模型配置，不是随便定的。

---

## 5. 文本检测：DBNet 后处理

检测模型输出一张**概率图**，每个像素表示"这里是文字"的概率。

后处理分三步：

1. **二值化**：像素值大于 0.2 标为文字，否则标为背景
2. **连通域标记**：用 BFS 把相邻的白点连成一片，每个连通域就是一个文字区域
3. **unclip 外扩**：模型输出的边界通常比真实文字略小，按 `面积 × 系数 / 周长` 的比例向外扩张，系数取 **1.4**

```text
面积 × 系数 / 周长
```

过滤规则：
- 过滤掉太小的区域（短边小于 3 像素）
- 过滤置信度太低的区域
- 按 y 坐标排序，保证阅读顺序

---

## 6. 文本识别：CRNN + CTC 解码

每个文本框裁剪出来，缩放到 **48 像素高**，宽度按比例保持。

识别模型输出 `[1, T, C]`：
- T 是时间步数
- C 是字符类别数（**6906**）

### CTC 贪心解码

每个时间步取概率最大的索引：
- 去掉空白符（索引 0）
- 合并连续重复的索引
- 映射到字符集就是文字

**示例**：输出 `[15, 15, 15, 0, 0, 23, 23, 0, 5]` → 合并去重 → `[15, 23, 5]` → 字符集映射 → "你好"

```text
[15, 15, 15, 0, 0, 23, 23, 0, 5]
[15, 23, 5]
```

---

## 7. 踩坑 1：识别出乱码

一开始跑测试，结果是这样：

```text
#1 沼桷轻哔茸藩舅爪锵喇
#2 ，辜唤
#3 沼桷轻哔暖敬茸藩舅爪锵喇梓备字蹿心航瞠郊
```

全乱码。

**原因**：字符集不匹配。ONNX 模型输出 6906 维，但下载的字典只有 **6622 字符**。`argmax` 算出来的索引如果大于 6622，就映射不到字符，全变成空白。

**解决方案：直接从 ONNX 模型元数据里提取字符集。**

PP-OCRv6 的 ONNX 模型在内部嵌入了字符列表。写 Python 脚本解析 protobuf 元数据，用 varint 解码读取字段长度，提取出 **6904 个字符**。

加上索引 0（blank）和最后一个（space），正好对应模型的 6906 维输出。

保存为 JSON 文件，前端加载时拼接成字符数组。

---

## 8. 踩坑 2：softmax 算出 NaN

加上置信度计算后，出现新问题：

```text
#1  conf NaN%  undefined字
```

**原因**：模型输出含 NaN 值，`Math.exp(NaN)` 在整行 softmax 里传播扩散。

**防护措施**：
- argmax 时跳过 `!isFinite(v)` 的值
- softmax 时跳过 `diff < -50` 和 `!isFinite(diff)` 的值
- 整行都不可用时跳过该时间步
- 置信度用 `Math.max(0.001, Math.min(p, 0.999))` 兜底

---

## 9. 踩坑 3：softmax 阈值过滤掉所有结果

加上置信度过滤后，结果全没了：

```text
⚠ 未检测到文本
```

**原因**：softmax 在 6906 维时，单字符概率很小，最高也就 **0.05 左右**。设的 0.3 阈值把全部结果都过滤了。

**解决**：改成 0 不过滤，等看到实际分布再调。

---

## 10. 构建完整应用

把检测和识别串起来，再加个 UI 就是完整应用。

**页面布局**：
- 左侧：拖拽上传区 + Canvas 画布
- 右侧：模型状态、进度条、识别结果

**识别结果展示**：按行显示，每行带序号、置信度百分比、识别文字。置信度高的绿色，中等的黄色，低的不显示。

**画布标注**：用彩色矩形框标注每个文本框的位置，上方显示文字和置信度。

---

## 11. 踩坑 4：small 模型架构完全不同

尝试换更大的 small 模型，结果发现检测头架构完全不同：

| 对比项 | tiny | small |
| --- | --- | --- |
| **Det 输出** | [1,3,960,960] DBNet 三通道 | [1,1,640,640] 单通道二值图 |
| **Rec 词表** | 6906（6904 字符） | 18710（18708 字符） |
| **检测后处理** | DBNet 阈值 + unclip | 轮廓检测 |
| **输入尺寸** | [1,3,960,960] | [1,3,640,640] |

> small 模型换了检测头架构，不再是 DBNet，是输出二值图后用**轮廓法**找文字区域，前端后处理代码需要重写。
> tiny 已经够用，small 改天再研究。

---

## 12. 完整项目结构

```
demo/2/
├── package.json
├── server.ts              # Bun 静态服务器
└── static/
    ├── index.html         # OCR 应用
    ├── ppocr_keys_v6_tiny.json  # 6904 字符集
    ├── ppocr_keys_v6_tiny.txt   # 字符集（文本格式）
    └── models/
        ├── PP-OCRv6_det_tiny.onnx   # 检测模型 1.74MB
        └── PP-OCRv6_rec_tiny.onnx   # 识别模型 4.28MB
```

启动：

```bash
cd demo/2
bun install
bun run dev
```

打开 http://localhost:3001 就能用。

---

## 13. 完整代码（单文件 index.html）

把上面所有模块拼起来，就是一个可运行的**单文件 HTML**。没有构建工具，没有依赖管理，直接双击就能跑。

约 600 行，覆盖检测、识别、后处理、UI 全部逻辑：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>浏览器端 OCR 演示 - PP-OCRv6 + onnxruntime-web</title>
  <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.min.js"></script>
</head>
<body>
  <h1>浏览器端 OCR</h1>
  <input type="file" id="fileInput" accept="image/*">
  <canvas id="canvas"></canvas>
  <div id="resultBody"></div>

  <script>
  let detSession = null, recSession = null, charList = null;
  let currentImageData = null, modelsLoaded = false;

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const resultBody = document.getElementById('resultBody');

  // PP-OCRv6 参数
  const DET_MAX_SIDE = 960;
  const DET_MEAN = [0.485, 0.456, 0.406];
  const DET_STD  = [0.229, 0.224, 0.225];
  const REC_MEAN = [0.5, 0.5, 0.5];
  const REC_STD  = [0.5, 0.5, 0.5];
  const REC_HEIGHT = 48;

  // 缩放 + RGB → CHW 归一化
  function rgbaToCHW(imageData, mean, std) {
    const { data, width, height } = imageData;
    const chw = new Float32Array(3 * height * width);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const si = (y * width + x) * 4, di = y * width + x;
        for (let c = 0; c < 3; c++)
          chw[c * height * width + di] = (data[si + c] / 255 - mean[c]) / std[c];
      }
    return chw;
  }

  // 用辅助 canvas 做双线性缩放
  function resizeImageData(imgSource, targetW, targetH) {
    const off = document.createElement('canvas');
    off.width = targetW; off.height = targetH;
    const offCtx = off.getContext('2d', { willReadFrequently: true });
    offCtx.drawImage(imgSource, 0, 0, targetW, targetH);
    return offCtx.getImageData(0, 0, targetW, targetH);
  }

  // 裁剪
  function cropImageData(imgData, x, y, w, h) {
    x = Math.max(0, Math.floor(x));
    y = Math.max(0, Math.floor(y));
    w = Math.min(Math.floor(w), imgData.width - x);
    h = Math.min(Math.floor(h), imgData.height - y);
    if (w <= 0 || h <= 0) return null;
    const cropped = new ImageData(w, h);
    for (let row = 0; row < h; row++)
      for (let col = 0; col < w; col++) {
        const si = ((y + row) * imgData.width + (x + col)) * 4;
        const di = (row * w + col) * 4;
        cropped.data[di]   = imgData.data[si];
        cropped.data[di+1] = imgData.data[si+1];
        cropped.data[di+2] = imgData.data[si+2];
        cropped.data[di+3] = imgData.data[si+3];
      }
    return cropped;
  }

  // DBNet 后处理：BFS 连通域 → unclip
  function dbBoxes(probData, ow, oh, scaleX, scaleY) {
    const thresh = 0.2, boxThresh = 0.4, unclip = 1.4;
    const bin = new Uint8Array(ow * oh);
    for (let i = 0; i < ow * oh; i++)
      bin[i] = probData[i] > thresh ? 1 : 0;

    const label = new Int32Array(ow * oh).fill(0);
    let curLabel = 0;
    const boxes = [];

    for (let s = 0; s < ow * oh; s++) {
      if (bin[s] !== 1 || label[s] !== 0) continue;
      curLabel++;
      const stack = [s];
      label[s] = curLabel;

      let minX = ow, minY = oh, maxX = 0, maxY = 0;
      let sum = 0, cnt = 0;

      while (stack.length > 0) {
        const p = stack.pop();
        const px = p % ow, py = (p / ow) | 0;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        sum += probData[p]; cnt++;
        // 四邻域扩展
        if (px > 0   && bin[p-1]  && !label[p-1])  { label[p-1] = curLabel; stack.push(p-1); }
        if (px < ow-1 && bin[p+1] && !label[p+1])  { label[p+1] = curLabel; stack.push(p+1); }
        if (py > 0   && bin[p-ow] && !label[p-ow])  { label[p-ow] = curLabel; stack.push(p-ow); }
        if (py < oh-1 && bin[p+ow] && !label[p+ow]) { label[p+ow] = curLabel; stack.push(p+ow); }
      }

      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (Math.min(bw, bh) < 3) continue;
      if (sum / cnt < boxThresh) continue;

      const area = bw * bh, peri = 2 * (bw + bh), d = area * unclip / peri;
      boxes.push({
        x0: Math.max(0, minX - d) * scaleX,
        y0: Math.max(0, minY - d) * scaleY,
        x1: Math.min(ow, maxX + d) * scaleX,
        y1: Math.min(oh, maxY + d) * scaleY,
      });
    }
    // 按 y 排序，保证阅读顺序
    boxes.sort((a, b) => a.y0 - b.y0);
    return boxes;
  }

  // CTC 贪心解码（含置信度）
  function ctcDecode(data, T, C) {
    const result = { text: '', confidences: [], confidence: 0, charCount: 0 };
    let prev = -1;
    for (let t = 0; t < T; t++) {
      let maxV = -1e9, idx = 0, base = t * C;
      for (let c = 0; c < C; c++) {
        const v = data[base + c];
        if (!isFinite(v)) continue;
        if (v > maxV) { maxV = v; idx = c; }
      }
      if (maxV === -1e9) continue;
      if (idx !== 0 && idx !== prev) {
        let sumE = 0;
        for (let c = 0; c < C; c++) {
          const diff = data[base + c] - maxV;
          if (diff < -50 || !isFinite(diff)) continue;
          sumE += Math.exp(diff);
        }
        const p = sumE > 0 ? 1 / sumE : 0.001;
        result.text += charList[idx] || '\uFFFD';
        result.confidences.push(Math.max(0.001, Math.min(p, 0.999)));
        result.charCount++;
      }
      prev = idx;
    }
    if (result.charCount > 0)
      result.confidence = result.confidences.reduce((a, b) => a + b, 0) / result.charCount;
    return result;
  }

  // 加载模型
  async function loadModels() {
    // 加载字符集
    const keysResp = await fetch('./ppocr_keys_v6_tiny.json');
    const dict = await keysResp.json();
    // blank(0) + 6904 字符 + space = 6906，对应模型输出维数
    charList = ['', ...dict, ' '];
    console.log('[OCR] 字符集:', dict.length, '+2 =', charList.length);

    // 检测模型（WebGL 后端）
    detSession = await ort.InferenceSession.create(
      './models/PP-OCRv6_det_tiny.onnx', { executionProviders: ['webgl'] }
    );

    // 识别模型
    recSession = await ort.InferenceSession.create(
      './models/PP-OCRv6_rec_tiny.onnx', { executionProviders: ['webgl'] }
    );

    modelsLoaded = true;
    resultBody.textContent = 'PP-OCRv6 就绪，上传图片开始识别';
    console.log('[OCR] 模型加载完成');
  }

  // 主 OCR 流水线
  async function runOCR() {
    if (!modelsLoaded || !currentImageData) return;
    resultBody.textContent = '';

    const imgData = currentImageData;
    const origW = imgData.width, origH = imgData.height;

    // 1. 检测预处理：长边 ≤ 960，取 32 倍数
    let r = Math.min(1, DET_MAX_SIDE / Math.max(origW, origH));
    const detW = Math.max(32, Math.round(origW * r / 32) * 32);
    const detH = Math.max(32, Math.round(origH * r / 32) * 32);
    const detResized = resizeImageData(canvas, detW, detH);
    const chw = rgbaToCHW(detResized, DET_MEAN, DET_STD);
    const detTensor = new ort.Tensor('float32', chw, [1, 3, detH, detW]);

    // 2. 检测推理
    const detResult = await detSession.run({ x: detTensor });
    const detOutput = detResult[detSession.outputNames[0]];
    const probData = detOutput.data;
    const probH = detOutput.dims[2], probW = detOutput.dims[3];
    const scaleX = origW / probW, scaleY = origH / probH;

    // 3. DBNet 后处理
    const boxes = dbBoxes(probData, probW, probH, scaleX, scaleY);
    console.log('[OCR] 检测到', boxes.length, '个文本区域');

    if (boxes.length === 0) {
      resultBody.textContent = '未检测到文本';
      return;
    }

    // 4. 逐个文本框识别
    const results = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const cw = b.x1 - b.x0, ch = b.y1 - b.y0;
      if (cw < 2 || ch < 2) continue;

      const cropped = cropImageData(imgData, b.x0, b.y0, cw, ch);
      if (!cropped) continue;

      // 缩放至 48 像素高
      const recW = Math.max(8, Math.round(REC_HEIGHT * cw / ch));
      const finalRecW = Math.min(recW, 2400);

      // crop 是 ImageData，转 canvas 供 drawImage 使用
      const off = document.createElement('canvas');
      off.width = cropped.width; off.height = cropped.height;
      off.getContext('2d').putImageData(cropped, 0, 0);
      const recResized = resizeImageData(off, finalRecW, REC_HEIGHT);
      const recInput = rgbaToCHW(recResized, REC_MEAN, REC_STD);
      const recTensor = new ort.Tensor('float32', recInput, [1, 3, REC_HEIGHT, finalRecW]);

      const recResult = await recSession.run({ x: recTensor });
      const recOutput = recResult[recSession.outputNames[0]];
      const T = recOutput.dims[1], C = recOutput.dims[2];

      const decoded = ctcDecode(recOutput.data, T, C);
      const text = decoded.text.trim();
      console.log(`#${i+1} conf=${decoded.confidence.toFixed(4)} chars=${decoded.charCount} → "${text.slice(0,50)}"`);
      if (text) results.push({ box: b, text, confidence: decoded.confidence });
    }

    // 5. 绘制文本框
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(imgData, 0, 0);
    for (const r of results) {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.box.x0, r.box.y0, r.box.x1 - r.box.x0, r.box.y1 - r.box.y0);
    }

    // 6. 显示识别结果
    resultBody.textContent = results.map(
      (r, i) => `#${i+1}  conf ${(r.confidence*100).toFixed(2)}%  ${r.text}`
    ).join('\n');
    console.log('[OCR] 完成:', results.length, '个文本块');
  }

  // 图片上传
  document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        currentImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resultBody.textContent = '图片已加载，点击上方再次运行 OCR';
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  // 点击 canvas 触发识别
  canvas.addEventListener('click', () => {
    if (currentImageData && modelsLoaded) runOCR();
  });

  canvas.width = 800; canvas.height = 400;
  loadModels();
  </script>
</body>
</html>
```

> 这就是完整的单文件应用，没有依赖管理，没有构建步骤。把两个 ONNX 模型和 `ppocr_keys_v6_tiny.json` 放到对应目录下就能跑。

---

## 14. 效果与要点总结

图片不上传服务器，全部在浏览器本地跑，**离线也能用**。

你需要的就三件事：
1. 找到 ONNX 模型
2. `InferenceSession.create()` 加载
3. `session.run()` 跑推理

---

## 验证测试关键信息汇总（供本项目参考）

| 项目 | 关键参数 |
| --- | --- |
| 检测模型 | PP-OCRv6_det_tiny.onnx，1.74MB，输入 [1,3,H,W]（长边≤960，32 倍数），输出概率图 [1,3,960,960] |
| 识别模型 | PP-OCRv6_rec_tiny.onnx，4.28MB，输入 [1,3,48,W]，输出 [1,T,6906] |
| 字符集 | 6906 维 = blank(0) + 6904 字符 + space，从 ONNX 元数据提取（下载的字典可能不匹配！） |
| 预处理 | mean/std：det [0.485,0.456,0.406]/[0.229,0.224,0.225]，rec [0.5,0.5,0.5]/[0.5,0.5,0.5] |
| DBNet 后处理 | 二值化阈值 0.2，box 置信度 0.4，unclip 系数 1.4，最小短边 3px |
| CTC 解码 | argmax + 去 blank(0) + 合并连续重复；softmax 需防 NaN |
| 置信度 | 单字符概率约 0.05 量级，阈值不可设太高（0.3 会全过滤） |
| small 模型 | 检测头改为二值图 + 轮廓检测，后处理需重写，词表 18710 |
| 踩坑 | ① 字符集 6622 与输出 6906 不匹配 → 乱码；② NaN 传播 → softmax 防护；③ 阈值过高全过滤 |
