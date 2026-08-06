// 模型文件加载：Cache API 持久化 + fetch 流式进度
// 从 web/js/loader.js 草稿移植为 TypeScript。下载一次后离线可用。
import type { ModelEntry } from "./types";

const CACHE_NAME = "ocr-models-v1";

async function getCache(): Promise<Cache | null> {
  if (!("caches" in window)) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch (e) {
    console.warn("[loader] Cache API 不可用:", (e as Error).message);
    return null;
  }
}

export interface FileProgress {
  pct: number;
  loaded: number;
  total: number;
  fromCache: boolean;
}

/**
 * 加载单个文件：先查 Cache API，未命中则流式下载并写回缓存。
 */
export async function loadFile(
  url: string,
  onProgress: (p: FileProgress) => void = () => {},
): Promise<{ buffer: ArrayBuffer; fromCache: boolean }> {
  const cache = await getCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buffer = await hit.arrayBuffer();
      onProgress({
        pct: 100,
        loaded: buffer.byteLength,
        total: buffer.byteLength,
        fromCache: true,
      });
      return { buffer, fromCache: true };
    }
  }

  // 下载前检查存储配额（仅告警，不阻断）
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota && usage !== undefined && quota - usage < 50 * 1024 * 1024) {
        console.warn(
          "[loader] 存储剩余空间不足:",
          Math.round((quota - usage) / 1048576),
          "MB",
        );
      }
    } catch {
      /* 忽略 */
    }
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}: ${url}`);
  const total = Number(resp.headers.get("content-length")) || 0;

  const reader = resp.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({
      pct: total ? (loaded / total) * 100 : 0,
      loaded,
      total,
      fromCache: false,
    });
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const buffer = merged.buffer;

  if (cache) {
    try {
      await cache.put(url, new Response(buffer.slice(0)));
    } catch (e) {
      console.warn("[loader] 缓存写入失败:", (e as Error).message);
    }
  }
  return { buffer, fromCache: false };
}

const FILE_LABELS: Record<string, string> = {
  det: "检测模型",
  rec: "识别模型",
  dict: "字符集",
};

export interface ModelFiles {
  det: ArrayBuffer;
  rec: ArrayBuffer;
  dict: string[];
  allFromCache: boolean;
}

/**
 * 按清单条目加载一整套模型文件（det / rec / dict）。
 * 整体进度按文件均摊，逐文件内部按字节汇报。
 */
export async function loadModelFiles(
  entry: ModelEntry,
  onProgress: (p: { pct: number; label: string; fromCache: boolean }) => void = () => {},
): Promise<ModelFiles> {
  const keys = ["det", "rec", "dict"] as const;
  const out: Partial<Record<(typeof keys)[number], ArrayBuffer | string[]>> = {};
  let allFromCache = true;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const result = await loadFile(entry.files[key], (p) => {
      onProgress({
        label: `${FILE_LABELS[key]} (${i + 1}/${keys.length})`,
        pct: ((i + p.pct / 100) / keys.length) * 100,
        fromCache: p.fromCache,
      });
    });
    allFromCache = allFromCache && result.fromCache;
    out[key] =
      key === "dict"
        ? (JSON.parse(new TextDecoder().decode(result.buffer)) as string[])
        : result.buffer;
  }

  return {
    det: out.det as ArrayBuffer,
    rec: out.rec as ArrayBuffer,
    dict: out.dict as string[],
    allFromCache,
  };
}
