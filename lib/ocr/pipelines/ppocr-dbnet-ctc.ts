// PP-OCR 流水线：DBNet 检测 + CTC 识别（最终 Module 位置）
// 只能被客户端模块引用（onnxruntime-web 的 exports 对 node 显式禁用）。
// 全量导入：/webgpu 条件导入不含 webgl 后端，而 webgl 是 iOS/Safari 的 GPU 兜底。
import * as ort from "onnxruntime-web";
import { withBasePath } from "../manifest";
import type {
  OcrLine,
  OcrPipeline,
  OcrRunResult,
  PpocrModelEntry,
  ProgressFn,
} from "../types";

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD = [0.5, 0.5, 0.5];

// ===== 图像工具 =====
function rgbaToCHW(
  imageData: ImageData,
  mean: number[],
  std: number[],
  colorOrder: "BGR",
): Float32Array {
  const { data, width, height } = imageData;
  const chw = new Float32Array(3 * height * width);
  // ImageData 为 RGBA；BGR 时通道 0←B、1←G、2←R
  const order = colorOrder === "BGR" ? [2, 1, 0] : [0, 1, 2];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * width + x;
      for (let c = 0; c < 3; c++) {
        chw[c * height * width + di] = (data[si + order[c]] / 255 - mean[c]) / std[c];
      }
    }
  }
  return chw;
}

function resizeImageData(
  imgSource: CanvasImageSource,
  targetW: number,
  targetH: number,
): ImageData {
  const off = document.createElement("canvas");
  off.width = targetW;
  off.height = targetH;
  const offCtx = off.getContext("2d", { willReadFrequently: true })!;
  offCtx.drawImage(imgSource, 0, 0, targetW, targetH);
  return offCtx.getImageData(0, 0, targetW, targetH);
}

function cropImageData(
  imgData: ImageData,
  x: number,
  y: number,
  w: number,
  h: number,
): ImageData | null {
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
      cropped.data[di] = imgData.data[si];
      cropped.data[di + 1] = imgData.data[si + 1];
      cropped.data[di + 2] = imgData.data[si + 2];
      cropped.data[di + 3] = imgData.data[si + 3];
    }
  }
  return cropped;
}

// ===== DBNet 后处理：BFS 连通域 → unclip =====
function dbBoxes(
  probData: Float32Array,
  ow: number,
  oh: number,
  scaleX: number,
  scaleY: number,
  detThresh: number,
  boxThresh: number,
  unclipRatio: number,
  minBoxSide: number,
) {
  const bin = new Uint8Array(ow * oh);
  for (let i = 0; i < ow * oh; i++) bin[i] = probData[i] > detThresh ? 1 : 0;

  const label = new Int32Array(ow * oh);
  let curLabel = 0;
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];

  for (let s = 0; s < ow * oh; s++) {
    if (bin[s] !== 1 || label[s] !== 0) continue;
    curLabel++;
    const stack = [s];
    label[s] = curLabel;

    let minX = ow,
      minY = oh,
      maxX = 0,
      maxY = 0;
    let sum = 0,
      cnt = 0;

    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % ow;
      const py = (p / ow) | 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      sum += probData[p];
      cnt++;
      if (px > 0 && bin[p - 1] && !label[p - 1]) {
        label[p - 1] = curLabel;
        stack.push(p - 1);
      }
      if (px < ow - 1 && bin[p + 1] && !label[p + 1]) {
        label[p + 1] = curLabel;
        stack.push(p + 1);
      }
      if (py > 0 && bin[p - ow] && !label[p - ow]) {
        label[p - ow] = curLabel;
        stack.push(p - ow);
      }
      if (py < oh - 1 && bin[p + ow] && !label[p + ow]) {
        label[p + ow] = curLabel;
        stack.push(p + ow);
      }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (Math.min(bw, bh) < minBoxSide) continue;
    if (sum / cnt < boxThresh) continue;

    const area = bw * bh;
    const peri = 2 * (bw + bh);
    const d = (area * unclipRatio) / peri;
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

// ===== CTC 贪心解码（含 NaN 防护 + probMode）=====
function ctcDecode(data: Float32Array, T: number, C: number, charList: string[]) {
  const result = { text: "", confidence: 0, charCount: 0 };
  let prev = -1;
  const confs: number[] = [];
  // rec 模型图内置 Softmax，输出已是概率分布时置信度直接取 max；
  // 否则按 logits 做数值稳定 softmax（兼容不带 softmax 的导出）
  let probMode: boolean | null = null;
  for (let t = 0; t < T; t++) {
    let maxV = -1e9,
      minV = 1e9,
      idx = 0,
      rowSum = 0;
    const base = t * C;
    for (let c = 0; c < C; c++) {
      const v = data[base + c];
      if (!isFinite(v)) continue;
      rowSum += v;
      if (v < minV) minV = v;
      if (v > maxV) {
        maxV = v;
        idx = c;
      }
    }
    if (maxV === -1e9) continue; // 整行 NaN
    if (probMode === null) probMode = minV >= -1e-6 && Math.abs(rowSum - 1) < 0.02;
    if (idx !== 0 && idx !== prev) {
      let p: number;
      if (probMode) {
        p = maxV;
      } else {
        let sumE = 0;
        for (let c = 0; c < C; c++) {
          const diff = data[base + c] - maxV;
          if (diff < -50 || !isFinite(diff)) continue;
          sumE += Math.exp(diff);
        }
        p = sumE > 0 ? 1 / sumE : 0.001;
      }
      result.text += charList[idx] !== undefined ? charList[idx] : "";
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

async function createSession(buffer: ArrayBuffer) {
  const candidates = ["webgpu", "webgl", "wasm"] as const;
  const bytes = new Uint8Array(buffer);
  let lastErr: unknown = null;
  for (const ep of candidates) {
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [ep],
      });
      return { session, ep };
    } catch (e) {
      lastErr = e;
      console.warn(`[${ep}] 不可用: ${(e as Error).message}`);
    }
  }
  throw lastErr || new Error("无可用后端");
}

function parseDict(buffer: ArrayBuffer): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error("字典 JSON 解析失败");
  }
  if (!Array.isArray(raw) || !raw.every((c) => typeof c === "string")) {
    throw new Error("字典必须是 string[]");
  }
  return raw;
}

/** onnxruntime-web 1.27：outputMetadata 为 ValueMetadata[]，按 name/isTensor/shape 读取 C */
function readOutputChannels(session: ort.InferenceSession): number | null {
  const name = session.outputNames[0];
  const metas = session.outputMetadata;
  if (!Array.isArray(metas)) return null;
  const meta = metas.find((m) => m.name === name);
  if (!meta || !meta.isTensor) return null;
  const last = meta.shape.at(-1);
  if (typeof last === "number" && Number.isFinite(last) && last > 0) return last;
  return null;
}

async function releaseSessions(
  ...sessions: ort.InferenceSession[]
): Promise<void> {
  for (const s of sessions) {
    try {
      await s.release();
    } catch (releaseErr) {
      console.warn("[ppocr] session release 失败:", (releaseErr as Error).message);
    }
  }
}

/**
 * 创建 PP-OCR Pipeline。files 为纯字节；dict 在此解析并做内容维数校验。
 */
export async function createPpocrPipeline(
  entry: PpocrModelEntry,
  files: Record<"det" | "rec" | "dict", ArrayBuffer>,
): Promise<OcrPipeline> {
  ort.env.wasm.wasmPaths = withBasePath("/ort/");
  ort.env.wasm.numThreads = 1;

  const chars = parseDict(files.dict);
  const charList = ["", ...chars, " "]; // blank(0) + dict + space
  if (charList.length !== entry.params.dictSize) {
    throw new Error(
      `字典维数不匹配: dict.length+2=${charList.length}, params.dictSize=${entry.params.dictSize}`,
    );
  }

  const P = entry.params;
  const detLoaded = await createSession(files.det);
  let recLoaded: Awaited<ReturnType<typeof createSession>>;
  try {
    recLoaded = await createSession(files.rec);
  } catch (e) {
    await releaseSessions(detLoaded.session);
    throw e;
  }

  const detSession = detLoaded.session;
  const recSession = recLoaded.session;
  const backend =
    detLoaded.ep === recLoaded.ep
      ? detLoaded.ep
      : `${detLoaded.ep}/${recLoaded.ep}`;

  const staticC = readOutputChannels(recSession);
  if (staticC === null) {
    await releaseSessions(detSession, recSession);
    throw new Error(
      "无法从 rec session.outputMetadata 读取静态输出维 C（需 name/isTensor/shape）",
    );
  }
  if (staticC !== entry.params.dictSize) {
    await releaseSessions(detSession, recSession);
    throw new Error(
      `rec 输出维 C=${staticC} 与 params.dictSize=${entry.params.dictSize} 不一致`,
    );
  }

  let disposed = false;

  async function run(
    imageData: ImageData,
    onProgress: ProgressFn = () => {},
  ): Promise<OcrRunResult> {
    if (disposed) throw new Error("Pipeline 已 dispose");
    const t0 = performance.now();
    onProgress({ pct: 5, label: "预处理…" });

    const origW = imageData.width;
    const origH = imageData.height;

    const src = document.createElement("canvas");
    src.width = origW;
    src.height = origH;
    src.getContext("2d")!.putImageData(imageData, 0, 0);

    const r = Math.min(1, P.detMaxSide / Math.max(origW, origH));
    const detW = Math.max(32, Math.round((origW * r) / 32) * 32);
    const detH = Math.max(32, Math.round((origH * r) / 32) * 32);
    const detResized = resizeImageData(src, detW, detH);
    const chw = rgbaToCHW(detResized, DET_MEAN, DET_STD, P.colorOrder);
    const detTensor = new ort.Tensor("float32", chw, [1, 3, detH, detW]);

    onProgress({ pct: 20, label: "文本检测推理…" });
    const tDet = performance.now();
    const detResult = await detSession.run({
      [detSession.inputNames[0]]: detTensor,
    });
    const detMs = performance.now() - tDet;
    const detOutput = detResult[detSession.outputNames[0]];
    const probData = detOutput.data as Float32Array;
    const probH = detOutput.dims[2];
    const probW = detOutput.dims[3];
    const scaleX = origW / probW;
    const scaleY = origH / probH;

    onProgress({ pct: 35, label: "DBNet 后处理…" });
    const boxes = dbBoxes(
      probData,
      probW,
      probH,
      scaleX,
      scaleY,
      P.detThresh,
      P.boxThresh,
      P.unclipRatio,
      P.minBoxSide,
    );
    console.log("[OCR] 检测到", boxes.length, "个文本区域");

    if (boxes.length === 0) {
      const totalMs = performance.now() - t0;
      return { results: [], boxesFound: 0, detMs, recMs: 0, totalMs, backend };
    }

    let recMs = 0;
    const results: OcrLine[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const cw = b.x1 - b.x0;
      const ch = b.y1 - b.y0;
      if (cw < 2 || ch < 2) continue;

      const cropped = cropImageData(imageData, b.x0, b.y0, cw, ch);
      if (!cropped) continue;

      // 缩放至 recHeight；长文本按 recMaxWidth 分块（与 Python 对照相同规则）
      const recW = Math.max(8, Math.round((P.recHeight * cw) / ch));
      const parts = Math.ceil(recW / P.recMaxWidth);
      const partW = Math.max(8, Math.round(recW / parts));

      const off = document.createElement("canvas");
      off.width = cropped.width;
      off.height = cropped.height;
      off.getContext("2d")!.putImageData(cropped, 0, 0);

      onProgress({
        pct: 35 + 55 * (i / boxes.length),
        label: `识别文本框 ${i + 1}/${boxes.length}…`,
      });

      let fullText = "";
      const confs: number[] = [];
      for (let p = 0; p < parts; p++) {
        const srcX = (cropped.width * p) / parts;
        const srcW = cropped.width / parts;
        const off2 = document.createElement("canvas");
        off2.width = Math.ceil(srcW);
        off2.height = cropped.height;
        off2.getContext("2d")!.drawImage(off, -srcX, 0);

        const recResized = resizeImageData(off2, partW, P.recHeight);
        const recInput = rgbaToCHW(recResized, REC_MEAN, REC_STD, P.colorOrder);
        const recTensor = new ort.Tensor("float32", recInput, [
          1,
          3,
          P.recHeight,
          partW,
        ]);

        const tRec = performance.now();
        const recResult = await recSession.run({
          [recSession.inputNames[0]]: recTensor,
        });
        recMs += performance.now() - tRec;
        const recOutput = recResult[recSession.outputNames[0]];
        const T = recOutput.dims[1];
        const C = recOutput.dims[2];
        if (C !== entry.params.dictSize) {
          throw new Error(
            `rec 输出维 C=${C} 与 params.dictSize=${entry.params.dictSize} 不一致`,
          );
        }
        const decoded = ctcDecode(recOutput.data as Float32Array, T, C, charList);
        fullText += decoded.text;
        if (decoded.charCount) confs.push(decoded.confidence);
      }

      const text = fullText.trim();
      const confidence = confs.length
        ? confs.reduce((a, b) => a + b, 0) / confs.length
        : 0;
      console.log(`#${i + 1} conf=${confidence.toFixed(4)} → "${text.slice(0, 50)}"`);
      if (text) results.push({ box: b, text, confidence });
    }

    const totalMs = performance.now() - t0;
    return { results, boxesFound: boxes.length, detMs, recMs, totalMs, backend };
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await Promise.all([detSession.release(), recSession.release()]);
  }

  return { backend, run, dispose };
}
