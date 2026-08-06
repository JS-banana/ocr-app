// PP-OCR 流水线：DBNet 检测 + CTC 识别
// 从原 index.html 抽出，预处理 / 后处理 / 推理逻辑保持不变。
// 依赖全局 ort（onnxruntime-web，由 index.html 的 <script> 加载）。

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD  = [0.229, 0.224, 0.225];
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD  = [0.5, 0.5, 0.5];
const DET_THRESH = 0.2;     // 二值化阈值
const BOX_THRESH = 0.4;     // 文本框平均概率阈值
const UNCLIP_RATIO = 1.4;   // unclip 外扩系数
const MIN_BOX_SIDE = 3;     // 最小短边像素

// ===== 图像工具 =====
function rgbaToCHW(imageData, mean, std) {
  const { data, width, height } = imageData;
  const chw = new Float32Array(3 * height * width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4, di = y * width + x;
      for (let c = 0; c < 3; c++) {
        chw[c * height * width + di] = (data[si + c] / 255 - mean[c]) / std[c];
      }
    }
  }
  return chw;
}

function resizeImageData(imgSource, targetW, targetH) {
  const off = document.createElement('canvas');
  off.width = targetW; off.height = targetH;
  const offCtx = off.getContext('2d', { willReadFrequently: true });
  offCtx.drawImage(imgSource, 0, 0, targetW, targetH);
  return offCtx.getImageData(0, 0, targetW, targetH);
}

function cropImageData(imgData, x, y, w, h) {
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  w = Math.min(Math.floor(w), imgData.width - x);
  h = Math.min(Math.floor(h), imgData.height - y);
  if (w <= 0 || h <= 0) return null;
  const cropped = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const si = ((y + row) * imgData.width + (x + col)) * 4;
      const di = (row * w + col) * 4;
      cropped.data[di]   = imgData.data[si];
      cropped.data[di+1] = imgData.data[si+1];
      cropped.data[di+2] = imgData.data[si+2];
      cropped.data[di+3] = imgData.data[si+3];
    }
  }
  return cropped;
}

// ===== DBNet 后处理：BFS 连通域 → unclip =====
function dbBoxes(probData, ow, oh, scaleX, scaleY) {
  const bin = new Uint8Array(ow * oh);
  for (let i = 0; i < ow * oh; i++) bin[i] = probData[i] > DET_THRESH ? 1 : 0;

  const label = new Int32Array(ow * oh);
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
      if (px > 0    && bin[p-1]  && !label[p-1])  { label[p-1] = curLabel; stack.push(p-1); }
      if (px < ow-1 && bin[p+1] && !label[p+1])  { label[p+1] = curLabel; stack.push(p+1); }
      if (py > 0    && bin[p-ow] && !label[p-ow])  { label[p-ow] = curLabel; stack.push(p-ow); }
      if (py < oh-1 && bin[p+ow] && !label[p+ow]) { label[p+ow] = curLabel; stack.push(p+ow); }
    }

    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (Math.min(bw, bh) < MIN_BOX_SIDE) continue;
    if (sum / cnt < BOX_THRESH) continue;

    const area = bw * bh, peri = 2 * (bw + bh), d = area * UNCLIP_RATIO / peri;
    boxes.push({
      x0: Math.max(0, minX - d) * scaleX,
      y0: Math.max(0, minY - d) * scaleY,
      x1: Math.min(ow, maxX + d) * scaleX,
      y1: Math.min(oh, maxY + d) * scaleY,
    });
  }
  boxes.sort((a, b) => a.y0 - b.y0);
  return boxes;
}

// ===== CTC 贪心解码（含 NaN 防护）=====
function ctcDecode(data, T, C, charList) {
  const result = { text: '', confidence: 0, charCount: 0 };
  let prev = -1;
  const confs = [];
  for (let t = 0; t < T; t++) {
    let maxV = -1e9, idx = 0, base = t * C;
    for (let c = 0; c < C; c++) {
      const v = data[base + c];
      if (!isFinite(v)) continue;
      if (v > maxV) { maxV = v; idx = c; }
    }
    if (maxV === -1e9) continue; // 整行 NaN
    if (idx !== 0 && idx !== prev) {
      let sumE = 0;
      for (let c = 0; c < C; c++) {
        const diff = data[base + c] - maxV;
        if (diff < -50 || !isFinite(diff)) continue;
        sumE += Math.exp(diff);
      }
      const p = sumE > 0 ? 1 / sumE : 0.001;
      result.text += (charList[idx] !== undefined) ? charList[idx] : '';
      confs.push(Math.max(0.001, Math.min(p, 0.999)));
      result.charCount++;
    }
    prev = idx;
  }
  if (result.charCount > 0) {
    result.confidence = confs.reduce((a, b) => a + b, 0) / result.charCount;
  }
  return result;
}

// ===== 创建会话（后端自动回退：webgpu → webgl → wasm/cpu）=====
async function createSession(buffer) {
  const candidates = ['webgpu', 'webgl', 'wasm'];
  const bytes = new Uint8Array(buffer);
  let lastErr = null;
  for (const ep of candidates) {
    try {
      const session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] });
      return { session, ep };
    } catch (e) {
      lastErr = e;
      console.warn(`[${ep}] 不可用: ${e.message}`);
    }
  }
  throw lastErr || new Error('无可用后端');
}

/**
 * 创建 PP-OCR 流水线。
 * @param {object} opts
 * @param {ArrayBuffer} opts.det  检测模型字节
 * @param {ArrayBuffer} opts.rec  识别模型字节
 * @param {string[]}    opts.dict 字符集数组
 * @param {object}      opts.params { detMaxSide, recHeight, recMaxWidth }
 * @returns {Promise<{run, backend, dictSize}>}
 */
export async function createPipeline({ det, rec, dict, params }) {
  const charList = ['', ...dict, ' ']; // blank(0) + dict + space
  const P = { detMaxSide: 960, recHeight: 48, recMaxWidth: 3200, ...(params || {}) };

  const detLoaded = await createSession(det);
  const recLoaded = await createSession(rec);
  const detSession = detLoaded.session;
  const recSession = recLoaded.session;
  const backend = detLoaded.ep === recLoaded.ep
    ? detLoaded.ep
    : `${detLoaded.ep}/${recLoaded.ep}`;

  /**
   * 跑一遍完整 OCR。
   * @param {ImageData} imageData
   * @param {(p:{pct:number,label:string})=>void} onProgress
   * @returns {Promise<{results:Array, boxesFound:number, detMs:number, recMs:number, totalMs:number, backend:string}>}
   */
  async function run(imageData, onProgress = () => {}) {
    const t0 = performance.now();
    onProgress({ pct: 5, label: '预处理…' });

    const origW = imageData.width, origH = imageData.height;

    // 源画布（原实现直接读显示用 canvas，这里改为离屏）
    const src = document.createElement('canvas');
    src.width = origW; src.height = origH;
    src.getContext('2d').putImageData(imageData, 0, 0);

    // 1. 检测预处理：长边 ≤ detMaxSide，取 32 倍数
    const r = Math.min(1, P.detMaxSide / Math.max(origW, origH));
    const detW = Math.max(32, Math.round(origW * r / 32) * 32);
    const detH = Math.max(32, Math.round(origH * r / 32) * 32);
    const detResized = resizeImageData(src, detW, detH);
    const chw = rgbaToCHW(detResized, DET_MEAN, DET_STD);
    const detTensor = new ort.Tensor('float32', chw, [1, 3, detH, detW]);

    // 2. 检测推理
    onProgress({ pct: 20, label: '文本检测推理…' });
    const tDet = performance.now();
    const detResult = await detSession.run({ [detSession.inputNames[0]]: detTensor });
    const detMs = performance.now() - tDet;
    const detOutput = detResult[detSession.outputNames[0]];
    const probData = detOutput.data;
    const probH = detOutput.dims[2], probW = detOutput.dims[3];
    const scaleX = origW / probW, scaleY = origH / probH;

    // 3. DBNet 后处理
    onProgress({ pct: 35, label: 'DBNet 后处理…' });
    const boxes = dbBoxes(probData, probW, probH, scaleX, scaleY);
    console.log('[OCR] 检测到', boxes.length, '个文本区域');

    if (boxes.length === 0) {
      const totalMs = performance.now() - t0;
      return { results: [], boxesFound: 0, detMs, recMs: 0, totalMs, backend };
    }

    // 4. 逐个文本框识别
    let recMs = 0;
    const results = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const cw = b.x1 - b.x0, ch = b.y1 - b.y0;
      if (cw < 2 || ch < 2) continue;

      const cropped = cropImageData(imageData, b.x0, b.y0, cw, ch);
      if (!cropped) continue;

      // 缩放至 recHeight 像素高（长文本分块处理）
      const recW = Math.max(8, Math.round(P.recHeight * cw / ch));
      const parts = Math.ceil(recW / P.recMaxWidth);
      const partW = Math.max(8, Math.round(recW / parts));

      const off = document.createElement('canvas');
      off.width = cropped.width; off.height = cropped.height;
      off.getContext('2d').putImageData(cropped, 0, 0);

      onProgress({ pct: 35 + 55 * (i / boxes.length), label: `识别文本框 ${i + 1}/${boxes.length}…` });

      let fullText = '';
      const confs = [];
      for (let p = 0; p < parts; p++) {
        const srcX = cropped.width * p / parts;
        const srcW = cropped.width / parts;
        const off2 = document.createElement('canvas');
        off2.width = Math.ceil(srcW); off2.height = cropped.height;
        off2.getContext('2d').drawImage(off, -srcX, 0);

        const recResized = resizeImageData(off2, partW, P.recHeight);
        const recInput = rgbaToCHW(recResized, REC_MEAN, REC_STD);
        const recTensor = new ort.Tensor('float32', recInput, [1, 3, P.recHeight, partW]);

        const tRec = performance.now();
        const recResult = await recSession.run({ [recSession.inputNames[0]]: recTensor });
        recMs += performance.now() - tRec;
        const recOutput = recResult[recSession.outputNames[0]];
        const T = recOutput.dims[1], C = recOutput.dims[2];
        const decoded = ctcDecode(recOutput.data, T, C, charList);
        fullText += decoded.text;
        if (decoded.charCount) confs.push(decoded.confidence);
      }

      const text = fullText.trim();
      const confidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
      console.log(`#${i+1} conf=${confidence.toFixed(4)} → "${text.slice(0, 50)}"`);
      if (text) results.push({ box: b, text, confidence });
    }

    const totalMs = performance.now() - t0;
    return { results, boxesFound: boxes.length, detMs, recMs, totalMs, backend };
  }

  return { run, backend, dictSize: charList.length };
}
