// 通用资产加载：Cache API + revision 键 + 纯字节；不解析 dict、不理解模型结构
import { assetCacheKey, withBasePath } from "./manifest";
import type { AssetFile, ModelLoadProgress } from "./types";

const CACHE_NAME = "ocr-models-v1";

async function getCache(): Promise<Cache | null> {
  if (typeof window === "undefined" || !("caches" in window)) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch (e) {
    console.warn("[loader] Cache API 不可用:", (e as Error).message);
    return null;
  }
}

function assertSizeBytes(
  buffer: ArrayBuffer,
  expected: number,
  url: string,
  source: "cache" | "network",
): void {
  if (buffer.byteLength !== expected) {
    throw new Error(
      `资产字节数不匹配 (${source}): ${url} 实际 ${buffer.byteLength} ≠ 声明 sizeBytes ${expected}`,
    );
  }
}

async function fetchNetwork(
  file: AssetFile,
  key: string,
  cache: Cache | null,
  onBytes?: (loaded: number, fromCache: boolean) => void,
): Promise<ArrayBuffer> {
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
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

  const url = withBasePath(file.url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}: ${url}`);

  let buffer: ArrayBuffer;

  if (!resp.body) {
    buffer = await resp.arrayBuffer();
    onBytes?.(buffer.byteLength, false);
  } else {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onBytes?.(loaded, false);
    }

    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    buffer = merged.buffer;
  }

  // 网络错配：失败且不写入缓存
  assertSizeBytes(buffer, file.sizeBytes, file.url, "network");

  if (cache) {
    try {
      await cache.put(key, new Response(buffer.slice(0)));
    } catch (e) {
      console.warn("[loader] 缓存写入失败:", (e as Error).message);
    }
  }
  return buffer;
}

async function loadOne(
  file: AssetFile,
  revision: string,
  onBytes?: (loaded: number, fromCache: boolean) => void,
): Promise<{ buffer: ArrayBuffer; fromCache: boolean }> {
  const key = assetCacheKey(file.url, revision);
  const cache = await getCache();

  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const buffer = await hit.arrayBuffer();
      if (buffer.byteLength === file.sizeBytes) {
        onBytes?.(buffer.byteLength, true);
        return { buffer, fromCache: true };
      }
      // 坏 cache：删除后走网络重取
      console.warn(
        `[loader] 缓存字节错配，删除后重取: ${file.url} ` +
          `${buffer.byteLength} ≠ ${file.sizeBytes}`,
      );
      try {
        await cache.delete(key);
      } catch (e) {
        console.warn("[loader] 坏缓存删除失败:", (e as Error).message);
      }
    }
  }

  const buffer = await fetchNetwork(file, key, cache, onBytes);
  return { buffer, fromCache: false };
}

/**
 * 按文件描述加载字节。cache key = url?rev=revision。
 * 进度按 sizeBytes 加权；无法确定总大小时 pct 为 null。
 * 最终 buffer.byteLength 必须等于声明 sizeBytes。
 */
export async function loadAssets(
  files: Readonly<Record<string, AssetFile>>,
  revision: string,
  onProgress?: (progress: ModelLoadProgress) => void,
): Promise<{
  files: Record<string, ArrayBuffer>;
  source: "cache" | "network" | "mixed";
}> {
  const entries = Object.entries(files);
  const totalKnown = entries.reduce((s, [, f]) => s + f.sizeBytes, 0);
  const out: Record<string, ArrayBuffer> = {};
  let cacheHits = 0;
  let networkGets = 0;
  const loadedPerKey: Record<string, number> = {};

  const report = (label: string, fromCache: boolean) => {
    if (!onProgress) return;
    if (!(totalKnown > 0)) {
      onProgress({ pct: null, label, fromCache });
      return;
    }
    let weighted = 0;
    for (const [k, f] of entries) {
      const got = loadedPerKey[k] ?? 0;
      weighted += Math.min(got, f.sizeBytes);
    }
    onProgress({
      pct: Math.min(100, (weighted / totalKnown) * 100),
      label,
      fromCache,
    });
  };

  for (const [key, file] of entries) {
    const label = `下载 ${key}`;
    const result = await loadOne(file, revision, (loaded, fromCache) => {
      loadedPerKey[key] = loaded;
      report(fromCache ? "读取本机缓存" : label, fromCache);
    });
    loadedPerKey[key] = file.sizeBytes;
    out[key] = result.buffer;
    if (result.fromCache) cacheHits++;
    else networkGets++;
    report(result.fromCache ? "读取本机缓存" : label, result.fromCache);
  }

  let source: "cache" | "network" | "mixed";
  if (networkGets === 0) source = "cache";
  else if (cacheHits === 0) source = "network";
  else source = "mixed";

  return { files: out, source };
}

/** 按整份 catalog 有效 key 集合清理；不在集合内的条目删除 */
export async function pruneAssetCache(
  validCacheKeys: ReadonlySet<string>,
): Promise<void> {
  const cache = await getCache();
  if (!cache) return;
  try {
    const keys = await cache.keys();
    await Promise.all(
      keys.map(async (req) => {
        const keyUrl = typeof req === "string" ? req : req.url;
        // Cache API 可能存绝对 URL；用 pathname+search 或完整串比对
        let rel = keyUrl;
        try {
          const u = new URL(keyUrl, "http://localhost");
          rel = u.pathname + u.search;
        } catch {
          /* keep */
        }
        if (!validCacheKeys.has(rel) && !validCacheKeys.has(keyUrl)) {
          await cache.delete(req);
        }
      }),
    );
  } catch (e) {
    console.warn("[loader] 缓存清理失败:", (e as Error).message);
  }
}
