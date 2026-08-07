// Manifest/Catalog：不可信 JSON → 已校验 discriminated union（下载前失败）
import type {
  AssetFile,
  ModelEntry,
  ModelSummary,
  PpocrFiles,
  PpocrModelEntry,
  PpocrParams,
  ValidatedModelCatalog,
} from "./types";

/**
 * 部署子路径（如 GitHub Pages `/ocr-app`）。
 * 由 next.config 把 BASE_PATH 注入为 NEXT_PUBLIC_BASE_PATH；本地为空。
 */
export function appBasePath(): string {
  return process.env.NEXT_PUBLIC_BASE_PATH ?? "";
}

/**
 * 给站点根绝对路径加上 basePath。
 * 清单里仍保持 `/models/...` 规范；仅在实际 fetch / wasmPaths 时调用。
 */
export function withBasePath(path: string): string {
  const base = appBasePath();
  if (!base || !path.startsWith("/") || path.startsWith("//")) return path;
  if (path === base || path.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}

export class ManifestError extends Error {
  readonly modelId: string | null;
  readonly path: string;

  constructor(message: string, opts: { modelId?: string | null; path: string }) {
    const id = opts.modelId ?? null;
    const prefix = id ? `model ${id}: ` : "";
    super(`${prefix}${opts.path}: ${message}`);
    this.name = "ManifestError";
    this.modelId = id;
    this.path = opts.path;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string, modelId?: string | null): never {
  throw new ManifestError(message, { path, modelId });
}

function expectString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  modelId?: string | null,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    fail(`${path}.${key}`, "必须是非空字符串", modelId);
  }
  return v;
}

function expectBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  modelId?: string | null,
): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") {
    fail(`${path}.${key}`, "必须是 boolean", modelId);
  }
  return v;
}

function expectFiniteNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  modelId?: string | null,
  opts?: { positive?: boolean; min?: number; max?: number },
): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${path}.${key}`, "必须是有限数字", modelId);
  }
  if (opts?.positive && !(v > 0)) {
    fail(`${path}.${key}`, "必须是正数", modelId);
  }
  if (opts?.min !== undefined && v < opts.min) {
    fail(`${path}.${key}`, `必须 ≥ ${opts.min}`, modelId);
  }
  if (opts?.max !== undefined && v > opts.max) {
    fail(`${path}.${key}`, `必须 ≤ ${opts.max}`, modelId);
  }
  return v;
}

/** 固定同源 base：用 URL 解析拦截反斜杠/外部 origin，只允许 /models/ 规范路径 */
const STATIC_ASSET_BASE = "https://ocr.local";

/** 本站静态资产 URL：仅接受规范 /models/… 路径，拒绝外部、query/hash、反斜杠、穿越 */
function expectStaticUrl(
  url: unknown,
  path: string,
  modelId: string,
): string {
  if (typeof url !== "string" || url.trim() === "") {
    fail(path, "必须是非空字符串", modelId);
  }
  if (url.includes("\\")) {
    fail(path, "禁止反斜杠路径（可被解析为跨域）", modelId);
  }
  if (url.includes("?") || url.includes("#")) {
    fail(path, "禁止 query 或 hash", modelId);
  }
  if (/^https?:\/\//i.test(url) || url.startsWith("//")) {
    fail(path, "禁止外部 URL，须为本站静态路径", modelId);
  }
  if (!url.startsWith("/")) {
    fail(path, "须以 / 开头的本站路径", modelId);
  }
  let parsed: URL;
  try {
    parsed = new URL(url, STATIC_ASSET_BASE);
  } catch {
    fail(path, "不是合法 URL", modelId);
  }
  if (parsed.origin !== STATIC_ASSET_BASE) {
    fail(path, "禁止外部 URL，须为本站静态路径", modelId);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    fail(path, "禁止 query 或 hash", modelId);
  }
  const pathname = parsed.pathname;
  if (!pathname.startsWith("/models/")) {
    fail(path, "须为本站 /models/ 下静态路径", modelId);
  }
  const rest = pathname.slice("/models/".length);
  if (
    !rest ||
    rest.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    fail(path, "须为本站 /models/ 下规范文件路径（禁止穿越与空段）", modelId);
  }
  return pathname;
}

function parseAssetFile(
  raw: unknown,
  path: string,
  modelId: string,
): AssetFile {
  if (!isPlainObject(raw)) {
    fail(path, "必须是 { url, sizeBytes } 对象", modelId);
  }
  const url = expectStaticUrl(raw.url, `${path}.url`, modelId);
  const sizeBytes = expectFiniteNumber(raw, "sizeBytes", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(sizeBytes)) {
    fail(`${path}.sizeBytes`, "必须是正整数", modelId);
  }
  return { url, sizeBytes };
}

function parsePpocrFiles(
  raw: unknown,
  path: string,
  modelId: string,
): PpocrFiles {
  if (!isPlainObject(raw)) {
    fail(path, "必须是对象", modelId);
  }
  const keys = Object.keys(raw).sort();
  const expected = ["det", "dict", "rec"];
  if (keys.length !== 3 || keys.some((k, i) => k !== expected[i])) {
    fail(path, "必须恰好包含 det、rec、dict 三个键", modelId);
  }
  return {
    det: parseAssetFile(raw.det, `${path}.det`, modelId),
    rec: parseAssetFile(raw.rec, `${path}.rec`, modelId),
    dict: parseAssetFile(raw.dict, `${path}.dict`, modelId),
  };
}

function parsePpocrParams(
  raw: unknown,
  path: string,
  modelId: string,
): PpocrParams {
  if (!isPlainObject(raw)) {
    fail(path, "必须是对象", modelId);
  }
  const colorOrder = expectString(raw, "colorOrder", path, modelId);
  if (colorOrder !== "BGR") {
    fail(`${path}.colorOrder`, '当前仅允许 "BGR"', modelId);
  }
  const detMaxSide = expectFiniteNumber(raw, "detMaxSide", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(detMaxSide)) {
    fail(`${path}.detMaxSide`, "必须是正整数", modelId);
  }
  const recHeight = expectFiniteNumber(raw, "recHeight", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(recHeight)) {
    fail(`${path}.recHeight`, "必须是正整数", modelId);
  }
  const recMaxWidth = expectFiniteNumber(raw, "recMaxWidth", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(recMaxWidth)) {
    fail(`${path}.recMaxWidth`, "必须是正整数", modelId);
  }
  const dictSize = expectFiniteNumber(raw, "dictSize", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(dictSize) || dictSize < 3) {
    fail(`${path}.dictSize`, "必须是 ≥ 3 的整数（blank + chars + space）", modelId);
  }
  const detThresh = expectFiniteNumber(raw, "detThresh", path, modelId, {
    min: 0,
    max: 1,
  });
  const boxThresh = expectFiniteNumber(raw, "boxThresh", path, modelId, {
    min: 0,
    max: 1,
  });
  const unclipRatio = expectFiniteNumber(raw, "unclipRatio", path, modelId, {
    positive: true,
  });
  const minBoxSide = expectFiniteNumber(raw, "minBoxSide", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(minBoxSide)) {
    fail(`${path}.minBoxSide`, "必须是正整数", modelId);
  }
  if (recMaxWidth < recHeight) {
    fail(`${path}.recMaxWidth`, "必须 ≥ recHeight", modelId);
  }
  return {
    detMaxSide,
    recHeight,
    recMaxWidth,
    dictSize,
    colorOrder: "BGR",
    detThresh,
    boxThresh,
    unclipRatio,
    minBoxSide,
  };
}

function parsePpocrEntry(
  raw: Record<string, unknown>,
  index: number,
): PpocrModelEntry {
  const path = `models[${index}]`;
  const id = expectString(raw, "id", path);
  const name = expectString(raw, "name", path, id);
  const label = expectString(raw, "label", path, id);
  const revision = expectString(raw, "revision", path, id);
  const recommended = expectBoolean(raw, "recommended", path, id);
  const pipeline = expectString(raw, "pipeline", path, id);
  if (pipeline !== "ppocr-dbnet-ctc") {
    fail(
      `${path}.pipeline`,
      `未知 pipeline "${pipeline}"（当前仅支持 ppocr-dbnet-ctc）`,
      id,
    );
  }
  const files = parsePpocrFiles(raw.files, `${path}.files`, id);
  const params = parsePpocrParams(raw.params, `${path}.params`, id);
  return {
    id,
    name,
    label,
    recommended,
    revision,
    pipeline: "ppocr-dbnet-ctc",
    files,
    params,
  };
}

/** 解析并完整校验 catalog；任何结构/参数错误在此抛出（早于资产下载） */
export function parseModelCatalog(raw: unknown): ValidatedModelCatalog {
  if (!isPlainObject(raw)) {
    fail("", "根节点必须是对象");
  }
  if (!Array.isArray(raw.models)) {
    fail("models", "必须是非空数组");
  }
  if (raw.models.length === 0) {
    fail("models", "不能为空");
  }

  const models: ModelEntry[] = [];
  const ids = new Set<string>();
  let recommendedCount = 0;

  for (let i = 0; i < raw.models.length; i++) {
    const item = raw.models[i];
    if (!isPlainObject(item)) {
      fail(`models[${i}]`, "必须是对象");
    }
    // 未知 pipeline：先读 pipeline 字段以便给出带 id 的错误
    if (typeof item.pipeline === "string" && item.pipeline !== "ppocr-dbnet-ctc") {
      const id = typeof item.id === "string" ? item.id : null;
      fail(
        `models[${i}].pipeline`,
        `未知 pipeline "${item.pipeline}"（当前仅支持 ppocr-dbnet-ctc）`,
        id,
      );
    }
    const entry = parsePpocrEntry(item, i);
    if (ids.has(entry.id)) {
      fail(`models[${i}].id`, `重复的模型 id "${entry.id}"`, entry.id);
    }
    ids.add(entry.id);
    if (entry.recommended) recommendedCount++;
    models.push(entry);
  }

  if (recommendedCount !== 1) {
    fail("models", `必须恰好有一个 recommended: true（当前 ${recommendedCount} 个）`);
  }

  return { models };
}

export function toModelSummary(entry: ModelEntry): ModelSummary {
  const downloadBytes =
    entry.files.det.sizeBytes +
    entry.files.rec.sizeBytes +
    entry.files.dict.sizeBytes;
  return {
    id: entry.id,
    name: entry.name,
    label: entry.label,
    recommended: entry.recommended,
    downloadBytes,
  };
}

/** 整份 catalog 的有效 Cache API 键集合（url?rev=revision） */
export function catalogCacheKeys(catalog: ValidatedModelCatalog): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const m of catalog.models) {
    for (const file of Object.values(m.files)) {
      keys.add(assetCacheKey(file.url, m.revision));
    }
  }
  return keys;
}

export function assetCacheKey(url: string, revision: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}rev=${encodeURIComponent(revision)}`;
}

/** 浏览器：fetch /models.json 并校验（子路径部署时自动加 basePath） */
export async function loadModelCatalog(
  url = withBasePath("/models.json"),
): Promise<ValidatedModelCatalog> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new ManifestError(`HTTP ${resp.status}`, { path: url });
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    throw new ManifestError("响应不是合法 JSON", { path: url });
  }
  return parseModelCatalog(raw);
}
