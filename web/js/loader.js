// 模型文件加载：Cache API 持久化 + fetch 流式进度
// 下载一次后离线可用；缓存按 URL 存储在 'ocr-models-v1'。

const CACHE_NAME = 'ocr-models-v1';

async function getCache() {
  if (!('caches' in window)) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch (e) {
    console.warn('[loader] Cache API 不可用:', e.message);
    return null;
  }
}

/**
 * 加载单个文件：先查 Cache API，未命中则流式下载并写回缓存。
 * @param {string} url
 * @param {(p:{pct:number,loaded:number,total:number,fromCache:boolean})=>void} onProgress
 * @returns {Promise<{buffer:ArrayBuffer, fromCache:boolean}>}
 */
export async function loadFile(url, onProgress = () => {}) {
  const cache = await getCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buffer = await hit.arrayBuffer();
      onProgress({ pct: 100, loaded: buffer.byteLength, total: buffer.byteLength, fromCache: true });
      return { buffer, fromCache: true };
    }
  }

  // 下载前检查存储配额（仅告警，不阻断）
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota && quota - usage < 50 * 1024 * 1024) {
        console.warn('[loader] 存储剩余空间不足:', Math.round((quota - usage) / 1048576), 'MB');
      }
    } catch (_) { /* 忽略 */ }
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}: ${url}`);
  const total = Number(resp.headers.get('content-length')) || 0;

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ pct: total ? (loaded / total) * 100 : 0, loaded, total, fromCache: false });
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  const buffer = merged.buffer;

  if (cache) {
    try {
      await cache.put(url, new Response(buffer.slice(0)));
    } catch (e) {
      console.warn('[loader] 缓存写入失败:', e.message);
    }
  }
  return { buffer, fromCache: false };
}

const FILE_LABELS = { det: '检测模型', rec: '识别模型', dict: '字符集' };

/**
 * 按清单条目加载一整套模型文件（det / rec / dict）。
 * 整体进度按文件均摊，逐文件内部按字节汇报。
 * @param {object} entry models.json 中的一条记录
 * @param {(p:{pct:number,label:string,fromCache:boolean})=>void} onProgress
 * @returns {Promise<{det:ArrayBuffer, rec:ArrayBuffer, dict:string[], allFromCache:boolean}>}
 */
export async function loadModelFiles(entry, onProgress = () => {}) {
  const keys = ['det', 'rec', 'dict'];
  const out = {};
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
    out[key] = key === 'dict' ? JSON.parse(new TextDecoder().decode(result.buffer)) : result.buffer;
  }

  return { det: out.det, rec: out.rec, dict: out.dict, allFromCache };
}
