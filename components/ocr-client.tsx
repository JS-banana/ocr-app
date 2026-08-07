"use client";

// 桌面产品界面：初始上传页 →（上传图片后）三栏工作区（原图标注 / 逐行结果 / 模型与操作）
// 全部推理在浏览器本地完成；OcrRuntime 是模型生命周期唯一所有者（Promise 去重、
// stale 清理、Tiny/Small 常驻、Medium 独占、busy 收口），UI 不直接持有 Pipeline。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { loadAssets, pruneAssetCache } from "@/lib/ocr/loader";
import {
  catalogCacheKeys,
  loadModelCatalog,
  toModelSummary,
} from "@/lib/ocr/manifest";
import {
  OcrRuntime,
  RuntimeBusyError,
  StaleSelectionError,
  type ModelState,
} from "@/lib/ocr/runtime";
import type { ModelSummary, OcrLine, OcrRunResult } from "@/lib/ocr/types";

type StatusKind = "" | "ok" | "loading";

interface CardStatus {
  text: string;
  kind: "ok" | "err" | "loading" | "";
}

interface CardProgress {
  pct: number | null;
  label: string;
}

/** 结果区状态：idle 未运行或有结果 / no-text 未检测到 / no-valid 有框无字 / error 推理失败 */
type ResultsState =
  | { kind: "idle" }
  | { kind: "no-text" }
  | { kind: "no-valid" }
  | { kind: "error"; message: string };

interface RunMeta {
  totalMs: number;
  detMs: number;
  recMs: number;
  backend: string;
}

/** 接线投影：UI 展示的大小由 files.*.sizeBytes 求和派生（MiB 取整） */
type UiModel = ModelSummary & { sizeMB: number };

function toUiModel(entry: Parameters<typeof toModelSummary>[0]): UiModel {
  const summary = toModelSummary(entry);
  return {
    ...summary,
    sizeMB: Math.round(summary.downloadBytes / (1024 * 1024)),
  };
}

/** runtime 状态 → 模型卡文案 */
function cardText(s: ModelState): CardStatus {
  switch (s.phase) {
    case "loading":
      return { text: "加载中…", kind: "loading" };
    case "ready":
      return { text: s.source === "cache" ? "就绪 · 已缓存" : "就绪", kind: "ok" };
    case "failed":
      return { text: "加载失败 · 点击重试", kind: "err" };
    default:
      return { text: "未加载", kind: "" };
  }
}

// 标注框调色板：画布上的框与结果行按序号一一同色
const BOX_COLORS = ["#2f7de1", "#2f9e63", "#e8912d", "#8b5cf6"];

const primaryBtn =
  "rounded-[8px] bg-accent px-4 py-2.5 text-[13px] font-medium text-[#171717] transition-[opacity,scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink enabled:[@media(hover:hover)]:hover:opacity-90 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
const secondaryBtn =
  "rounded-[8px] border border-border bg-panel px-4 py-2.5 text-[13px] font-medium text-text transition-[border-color,scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink enabled:[@media(hover:hover)]:hover:border-accent/70 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";

export default function OcrClient() {
  // ===== 状态 =====
  const [models, setModels] = useState<UiModel[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [cardStatus, setCardStatus] = useState<Record<string, CardStatus>>({});
  const [cardProgress, setCardProgress] = useState<Record<string, CardProgress>>({});
  const [statusText, setStatusText] = useState("正在读取模型配置…");
  const [statusKind, setStatusKind] = useState<StatusKind>("loading");
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [hasImage, setHasImage] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const [results, setResults] = useState<OcrLine[] | null>(null);
  const [resultsState, setResultsState] = useState<ResultsState>({ kind: "idle" });
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null);
  const [runProgress, setRunProgress] = useState<{ pct: number; label: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [copyState, setCopyState] = useState<"" | "ok" | "err">("");

  const runtimeRef = useRef<OcrRuntime | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  // 原图片名（用于 .txt 命名）；null 表示剪贴板来源
  const imageNameRef = useRef<string | null>(null);
  // 事件回调里读取的当前选择镜像（避免闭包过期）
  const currentIdRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentModel = models.find((m) => m.id === currentId) ?? null;
  const currentProgress = currentId ? cardProgress[currentId] : undefined;

  // ===== 模型选择（runtime 为生命周期唯一所有者；卡片/全局状态由事件驱动）=====
  const selectModel = useCallback(async (row: UiModel) => {
    const rt = runtimeRef.current;
    if (!rt) return;
    if (currentIdRef.current === row.id && rt.state(row.id).phase === "ready") {
      return;
    }
    currentIdRef.current = row.id;
    setCurrentId(row.id);

    // 切换模型：立即清除旧文字结果与旧标注框，避免结果看似属于新模型
    setResults(null);
    setResultsState({ kind: "idle" });
    setRunMeta(null);
    setRunProgress(null);
    setCopyState("");
    const canvas = canvasRef.current;
    const img = imageDataRef.current;
    if (canvas && img) canvas.getContext("2d")!.putImageData(img, 0, 0);

    setReady(false);
    setStatusText(`正在加载模型：${row.label}`);
    setStatusKind("loading");

    try {
      await rt.select(row.id);
    } catch (e) {
      // stale：已被更新的选择取代，状态由后续选择的事件驱动
      if (e instanceof StaleSelectionError) return;
      // busy：UI 已在运行期禁用切换，此处仅兜底。
      // select 在 busy 时未变更 runtime 状态，回滚乐观写入的当前选择镜像，避免 UI 与 runtime 脱节
      if (e instanceof RuntimeBusyError) {
        const actual = rt.selectedId();
        currentIdRef.current = actual;
        setCurrentId(actual);
        if (actual) {
          const st = rt.state(actual);
          setReady(st.phase === "ready");
          setStatusText(st.phase === "ready" ? "模型已就绪" : "模型加载中…");
          setStatusKind(st.phase === "ready" ? "ok" : "loading");
        }
        return;
      }
      // 真实失败：卡片与全局状态已由 onState 事件标记
      console.error(e);
    }
  }, []);

  // 启动：校验清单 → 建 runtime → 默认选中推荐模型（后台加载）；卸载时 dispose
  useEffect(() => {
    let cancelled = false;

    const applyState = (id: string, s: ModelState) => {
      if (cancelled) return;
      setCardStatus((prev) => ({ ...prev, [id]: cardText(s) }));
      if (s.phase === "ready" || s.phase === "failed") {
        setCardProgress((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      if (id !== currentIdRef.current) return;
      setReady(s.phase === "ready");
      if (s.phase === "ready") {
        setStatusText("模型已就绪");
        setStatusKind("ok");
      } else if (s.phase === "failed") {
        setStatusText(`模型加载失败：${s.error ?? "未知错误"}`);
        setStatusKind("");
      } else if (s.phase === "loading") {
        setStatusKind("loading");
      }
    };

    (async () => {
      try {
        const catalog = await loadModelCatalog();
        if (cancelled) return;
        void pruneAssetCache(catalogCacheKeys(catalog));
        // 浏览器 Gate 观测句柄：仅开发构建暴露（静态导出为 production，自动剔除）
        const debug =
          process.env.NODE_ENV !== "production"
            ? ({ rt: null, readyCount: {} } as unknown as {
                rt: OcrRuntime | null;
                readyCount: Record<string, number>;
              })
            : null;
        const rt = new OcrRuntime({
          catalog,
          loadAssets,
          onState: (id, s) => {
            // 每次进入 ready 恰对应一次 Session 创建（复用常驻不产生事件）
            if (debug && s.phase === "ready") {
              debug.readyCount[id] = (debug.readyCount[id] ?? 0) + 1;
            }
            applyState(id, s);
          },
          onLoadProgress: (id, p) => {
            if (cancelled) return;
            // 产品级进度阶段（方案 4.4）：不定进度不显示虚假百分比
            const prog: CardProgress =
              p.pct !== null && p.pct >= 100
                ? { pct: 100, label: "初始化推理引擎…" }
                : p.fromCache
                  ? { pct: p.pct, label: "读取本机缓存…" }
                  : p.pct === null
                    ? { pct: null, label: "下载模型…" }
                    : { pct: p.pct, label: `下载模型 ${Math.round(p.pct)}%` };
            setCardProgress((prev) => ({ ...prev, [id]: prog }));
            if (id !== currentIdRef.current) return;
            setStatusKind("loading");
            setStatusText(prog.label);
          },
        });
        if (debug) {
          debug.rt = rt;
          (window as unknown as { __ocrDebug?: typeof debug }).__ocrDebug = debug;
        }
        runtimeRef.current = rt;
        const list = catalog.models.map(toUiModel);
        setModels(list);
        const def = list.find((m) => m.recommended) || list[0];
        if (def) void selectModel(def);
      } catch (e) {
        if (!cancelled) {
          setManifestError((e as Error).message);
          setStatusText("模型配置加载失败");
          setStatusKind("");
        }
      }
    })();
    return () => {
      cancelled = true;
      const rt = runtimeRef.current;
      runtimeRef.current = null;
      if (rt) void rt.dispose();
      if (process.env.NODE_ENV !== "production") {
        delete (window as unknown as { __ocrDebug?: unknown }).__ocrDebug;
      }
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== 上传 =====
  const loadImageFile = useCallback(
    (file: File | undefined | null, origin: "file" | "paste") => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setImageError("不支持的文件格式，请选择 PNG / JPG / WebP 图片");
        return;
      }
      if (file.size === 0) {
        setImageError("文件为空，请重新选择图片");
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => setImageError("图片读取失败，请重试");
      reader.onload = (ev) => {
        const img = new Image();
        img.onerror = () => setImageError("图片解码失败，请换一张图片");
        img.onload = () => {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (!w || !h) {
            setImageError("图片解码失败，请换一张图片");
            return;
          }
          const off = document.createElement("canvas");
          off.width = w;
          off.height = h;
          const ctx = off.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          imageDataRef.current = ctx.getImageData(0, 0, w, h);
          imageNameRef.current = origin === "paste" ? null : file.name;
          setImageVersion((v) => v + 1);
          setHasImage(true);
          setImageError(null);
          setResults(null);
          setResultsState({ kind: "idle" });
          setRunMeta(null);
          setRunProgress(null);
          setCopyState("");
        };
        img.src = ev.target?.result as string;
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  // 画布只在工作区挂载：图片加载/替换后把原始 ImageData 画上去（标注框由 runOCR 叠加）
  useEffect(() => {
    if (!hasImage) return;
    const canvas = canvasRef.current;
    const img = imageDataRef.current;
    if (!canvas || !img) return;
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext("2d")!.putImageData(img, 0, 0);
  }, [hasImage, imageVersion]);

  // 全局粘贴：只处理剪贴板中的图片；焦点在文本控件时不拦截正常粘贴
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return;
      }
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            loadImageFile(file, "paste");
          }
          return;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadImageFile]);

  // 拖放落到投放区之外时阻止浏览器默认打开文件
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      loadImageFile(e.dataTransfer.files[0], "file");
    },
  };

  // ===== 识别 =====
  const runOCR = useCallback(async () => {
    const rt = runtimeRef.current;
    const imageData = imageDataRef.current;
    const canvas = canvasRef.current;
    if (!rt || !imageData || !canvas || !ready || running) return;
    setRunning(true);
    setCopyState("");

    try {
      const out: OcrRunResult = await rt.run(imageData, (p) =>
        setRunProgress({ pct: p.pct, label: p.label }),
      );
      setRunProgress(null);

      if (out.boxesFound === 0) {
        setResults(null);
        setRunMeta(null);
        setResultsState({ kind: "no-text" });
      } else {
        // 绘制标注框：与结果行同色，便于对照
        const ctx = canvas.getContext("2d")!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.putImageData(imageData, 0, 0);
        out.results.forEach((r, i) => {
          const c = BOX_COLORS[i % BOX_COLORS.length];
          ctx.fillStyle = c + "1f";
          ctx.fillRect(r.box.x0, r.box.y0, r.box.x1 - r.box.x0, r.box.y1 - r.box.y0);
          ctx.strokeStyle = c;
          ctx.lineWidth = 2;
          ctx.strokeRect(r.box.x0, r.box.y0, r.box.x1 - r.box.x0, r.box.y1 - r.box.y0);
        });
        setResults(out.results);
        setRunMeta({
          totalMs: out.totalMs,
          detMs: out.detMs,
          recMs: out.recMs,
          backend: out.backend,
        });
        setResultsState(out.results.length === 0 ? { kind: "no-valid" } : { kind: "idle" });
      }
    } catch (e) {
      console.error(e);
      setRunProgress(null);
      setResults(null);
      setRunMeta(null);
      setResultsState({ kind: "error", message: (e as Error).message });
    }
    setRunning(false);
  }, [ready, running]);

  // ===== 结果操作 =====
  const copyAll = useCallback(async () => {
    if (!results || results.length === 0) return;
    try {
      await navigator.clipboard.writeText(results.map((r) => r.text).join("\n"));
      setCopyState("ok");
    } catch (e) {
      console.error(e);
      setCopyState("err");
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState(""), 1600);
  }, [results]);

  const downloadTxt = useCallback(() => {
    if (!results || results.length === 0) return;
    const name = imageNameRef.current;
    const filename = name
      ? `${name.replace(/\.[^.]+$/, "")}-ocr.txt`
      : "clipboard-ocr.txt";
    const blob = new Blob([results.map((r) => r.text).join("\n")], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [results]);

  // 清空图片：结果、标注框、进度与错误一并清除；已创建的 Session 保留在 runtime 不释放
  const clearImage = useCallback(() => {
    imageDataRef.current = null;
    imageNameRef.current = null;
    setHasImage(false);
    setImageError(null);
    setResults(null);
    setResultsState({ kind: "idle" });
    setRunMeta(null);
    setRunProgress(null);
    setCopyState("");
    setDragOver(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // 模型卡 radiogroup 键盘操作：方向键移动选中（roving tabindex）
  const onModelGroupKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (running || models.length === 0) return;
    const idx = models.findIndex((m) => m.id === currentId);
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      next = (idx + 1) % models.length;
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      next = (idx - 1 + models.length) % models.length;
    }
    if (next < 0) return;
    e.preventDefault();
    const m = models[next];
    cardRefs.current[m.id]?.focus();
    void selectModel(m);
  };

  const runLabel = running
    ? "识别中…"
    : !ready
      ? "模型加载中…"
      : results
        ? "重新识别"
        : `使用 ${currentModel?.label ?? ""} 识别`;

  // ===== 渲染 =====
  return (
    <div className="flex min-h-dvh flex-col">
      {/* ===== 顶部栏 ===== */}
      <header className="border-b border-border bg-panel">
        <div className="mx-auto flex h-12 w-full max-w-[1600px] items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              <g
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                className="text-text/40"
              >
                <path d="M6.5 3H4.5A1.5 1.5 0 0 0 3 4.5v2" />
                <path d="M15.5 3h2A1.5 1.5 0 0 1 19 4.5v2" />
                <path d="M19 15.5v2a1.5 1.5 0 0 1-1.5 1.5h-2" />
                <path d="M6.5 19h-2A1.5 1.5 0 0 1 3 17.5v-2" />
              </g>
              <g stroke="#f0a23a" strokeWidth="1.6" strokeLinecap="round">
                <path d="M8 9.2h6" />
                <path d="M8 12.8h4.4" />
              </g>
            </svg>
            <span className="text-[15px] font-semibold tracking-tight">OCR</span>
          </div>
          <span className="text-[12px] text-muted">100% 本地运行 · 图片不上传</span>
        </div>
      </header>

      {!hasImage ? (
        /* ===== 初始上传状态 ===== */
        <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col px-4">
          <section className="pb-10 pt-20 text-center">
            <h1 className="text-[32px] font-semibold tracking-tight">图片文字识别</h1>
            <p className="mt-3 text-[15px] text-muted">
              粘贴、拖入或选择图片，识别过程完全在本机完成。
            </p>
          </section>

          <section className="mx-auto w-full max-w-3xl pb-24">
            <div
              role="button"
              tabIndex={0}
              aria-label="上传图片"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              {...dropHandlers}
              className={`flex min-h-[320px] cursor-pointer items-center justify-center rounded-[10px] border-[1.5px] border-dashed transition-[border-color,background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink ${
                dragOver
                  ? "border-accent bg-accent/[0.05]"
                  : "border-border bg-panel [@media(hover:hover)]:hover:border-accent/70"
              }`}
            >
              <div className="pointer-events-none flex flex-col items-center gap-3 px-6 text-center">
                <svg
                  width="36"
                  height="36"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className="text-muted/40"
                >
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <circle cx="9" cy="10" r="1.6" />
                  <path d="m21 15.5-4.8-4.8L7 20" />
                </svg>
                <p className="text-[14px] text-text">
                  拖入图片、点击选择，或直接 <span className="font-mono">Ctrl/⌘V</span> 粘贴
                </p>
                <p className="font-mono text-[11px] text-muted">PNG / JPG / WebP</p>
              </div>
            </div>

            {/* 模型状态（aria-live 播报） */}
            <div
              aria-live="polite"
              className="mt-5 flex min-h-[56px] flex-col items-center justify-center gap-2 text-center"
            >
              {manifestError ? (
                <>
                  <p className="text-[13px] text-err">模型配置加载失败:{manifestError}</p>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className={secondaryBtn}
                  >
                    刷新重试
                  </button>
                </>
              ) : statusKind === "loading" ? (
                <>
                  <p className="text-[13px] text-muted">{statusText}</p>
                  <div className="h-1 w-56 overflow-hidden rounded-full bg-border">
                    {currentProgress && currentProgress.pct !== null ? (
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-150"
                        style={{ width: `${currentProgress.pct}%` }}
                      />
                    ) : (
                      <div className="h-full w-full animate-pulse rounded-full bg-accent" />
                    )}
                  </div>
                </>
              ) : statusKind === "ok" ? (
                <p className="text-[13px] text-muted">模型已就绪，上传图片即可识别</p>
              ) : (
                <>
                  <p className="text-[13px] text-err">{statusText}</p>
                  {currentModel && (
                    <button
                      type="button"
                      onClick={() => void selectModel(currentModel)}
                      className={secondaryBtn}
                    >
                      重试
                    </button>
                  )}
                </>
              )}
              {imageError && <p className="text-[13px] text-err">{imageError}</p>}
            </div>
          </section>
        </main>
      ) : (
        /* ===== 识别工作区（固定三栏） ===== */
        <main className="mx-auto grid min-h-0 w-full max-w-[1600px] flex-1 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_320px] gap-4 p-4">
          {/* 左栏：原图与标注框 */}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-panel">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">原图</h2>
              <span className={`text-[11px] ${imageError ? "text-err" : "text-muted"}`}>
                {imageError ?? "拖入新图片或 Ctrl/⌘V 粘贴可替换"}
              </span>
            </div>
            <div
              {...dropHandlers}
              className={`flex min-h-0 flex-1 items-center justify-center p-4 transition-[background-color] duration-150 ${
                dragOver ? "bg-accent/[0.05]" : ""
              }`}
            >
              <canvas
                ref={canvasRef}
                className={`max-h-full max-w-full rounded-[4px] object-contain ${
                  dragOver ? "opacity-40" : ""
                }`}
              />
            </div>
          </section>

          {/* 中栏：逐行文字与置信度 */}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-panel">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">识别结果</h2>
              {currentModel && (
                <span className="truncate text-[11px] text-muted">
                  {currentModel.label} ·{" "}
                  <span className="font-mono">{currentModel.name}</span>
                </span>
              )}
            </div>
            {runProgress && (
              <div className="border-b border-border px-4 py-2.5" aria-live="polite">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted">
                  <span>{runProgress.label}</span>
                  <span className="font-mono tabular-nums">
                    {Math.round(runProgress.pct)}%
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-150"
                    style={{ width: `${runProgress.pct}%` }}
                  />
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {results && results.length > 0 ? (
                results.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 rounded-[6px] px-2.5 py-2 [@media(hover:hover)]:hover:bg-bg"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                      style={{ background: BOX_COLORS[i % BOX_COLORS.length] }}
                      aria-hidden="true"
                    />
                    <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 break-all text-[13.5px] leading-relaxed">
                      {r.text}
                    </span>
                    <span
                      className={`shrink-0 font-mono text-[11.5px] tabular-nums ${
                        r.confidence < 0.8 ? "text-accent-ink" : "text-muted"
                      }`}
                    >
                      {(r.confidence * 100).toFixed(1)}%
                    </span>
                  </div>
                ))
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <p
                    className={`text-[13px] ${
                      resultsState.kind === "error" ? "text-err" : "text-muted"
                    }`}
                  >
                    {resultsState.kind === "no-text"
                      ? "未检测到文本，请尝试更清晰的图片"
                      : resultsState.kind === "no-valid"
                        ? "检测到文本区域，但没有识别出有效文字"
                        : resultsState.kind === "error"
                          ? `识别失败：${resultsState.message}`
                          : ready
                            ? `点击「使用 ${currentModel?.label ?? ""} 识别」提取图中文字`
                            : "模型加载完成后即可识别"}
                  </p>
                </div>
              )}
            </div>
            <div className="border-t border-border px-4 py-2.5">
              <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted/70">
                运行详情
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-muted">
                {runMeta
                  ? `总耗时 ${Math.round(runMeta.totalMs)}ms · 检测 ${Math.round(runMeta.detMs)}ms · 识别 ${Math.round(runMeta.recMs)}ms · ${runMeta.backend}`
                  : "—"}
              </div>
            </div>
          </section>

          {/* 右栏：模型与操作 */}
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-panel">
            <div className="border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">模型</h2>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              <div
                role="radiogroup"
                aria-label="选择识别模型"
                onKeyDown={onModelGroupKeyDown}
                className="flex flex-col gap-2"
              >
                {models.map((m) => {
                  const st = cardStatus[m.id];
                  const prog = cardProgress[m.id];
                  const active = currentId === m.id;
                  return (
                    <button
                      key={m.id}
                      ref={(el) => {
                        cardRefs.current[m.id] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={active ? 0 : -1}
                      disabled={running}
                      onClick={() => void selectModel(m)}
                      className={`w-full rounded-[8px] border px-3.5 py-3 text-left transition-[border-color,background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink disabled:cursor-not-allowed disabled:opacity-55 ${
                        active
                          ? "border-accent bg-accent/[0.05]"
                          : "border-border bg-panel [@media(hover:hover)]:hover:border-accent/60"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                            active ? "border-accent" : "border-border"
                          }`}
                          aria-hidden="true"
                        >
                          {active && <span className="h-2 w-2 rounded-full bg-accent" />}
                        </span>
                        <span className="text-[13.5px] font-semibold tracking-tight">
                          {m.label}
                        </span>
                        {m.recommended && (
                          <span className="rounded-full bg-bg px-1.5 py-px text-[10px] text-muted">
                            推荐
                          </span>
                        )}
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
                          {m.sizeMB} MB
                        </span>
                      </div>
                      <div className="mt-1 pl-[26px]">
                        <div className="font-mono text-[11px] text-muted">{m.name}</div>
                        <div
                          className={`mt-0.5 text-[11.5px] ${
                            st?.kind === "err"
                              ? "text-err"
                              : st?.kind === "ok"
                                ? "text-accent-ink"
                                : "text-muted"
                          }`}
                        >
                          {prog
                            ? prog.label
                            : `${st?.text ?? "未加载"}${
                                m.sizeMB >= 100 && (!st || st.kind === "")
                                  ? " · 首次加载较慢"
                                  : ""
                              }`}
                        </div>
                        {prog && (
                          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
                            {prog.pct === null ? (
                              <div className="h-full w-full animate-pulse rounded-full bg-accent" />
                            ) : (
                              <div
                                className="h-full rounded-full bg-accent transition-[width] duration-150"
                                style={{ width: `${prog.pct}%` }}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              <p aria-live="polite" className="text-[11.5px] leading-relaxed text-muted">
                {statusText}
              </p>

              {results && results.length > 0 && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void copyAll()}
                    className={`${secondaryBtn} flex-1 ${
                      copyState === "err" ? "border-err text-err" : ""
                    }`}
                  >
                    {copyState === "ok"
                      ? "已复制"
                      : copyState === "err"
                        ? "复制失败"
                        : "复制全文"}
                  </button>
                  <button
                    type="button"
                    onClick={downloadTxt}
                    className={`${secondaryBtn} flex-1`}
                  >
                    下载 .txt
                  </button>
                </div>
              )}

              {/* 底部固定操作 */}
              <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => void runOCR()}
                  disabled={!ready || running}
                  className={primaryBtn}
                >
                  {runLabel}
                </button>
                <button
                  type="button"
                  onClick={clearImage}
                  disabled={running}
                  className={secondaryBtn}
                >
                  清空图片
                </button>
              </div>
            </div>
          </aside>
        </main>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          loadImageFile(e.target.files?.[0], "file");
          e.target.value = "";
        }}
      />
    </div>
  );
}
