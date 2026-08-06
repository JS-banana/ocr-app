"use client";

// OCR 客户端：模型选择 → 加载（Cache API）→ 传图 → 识别 → 结果展示
// 逻辑移植自 web/js/app.js 草稿，全部推理在浏览器本地完成。
import { useCallback, useEffect, useRef, useState } from "react";
import { loadModelFiles } from "@/lib/ocr/loader";
import { createPipeline, type Pipeline } from "@/lib/ocr/ppocr";
import type { Manifest, ModelEntry, OcrLine, OcrRunResult } from "@/lib/ocr/types";

type StatusKind = "" | "ok" | "loading";

interface CardStatus {
  text: string;
  kind: "ok" | "err" | "";
}

export default function OcrClient() {
  // ===== 状态 =====
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [cardStatus, setCardStatus] = useState<Record<string, CardStatus>>({});
  const [statusText, setStatusText] = useState("初始化…");
  const [statusKind, setStatusKind] = useState<StatusKind>("loading");
  const [modelProgress, setModelProgress] = useState<{ pct: number; label: string } | null>(null);
  const [runProgress, setRunProgress] = useState<{ pct: number; label: string } | null>(null);
  const [modelInfo, setModelInfo] = useState("");
  const [hasImage, setHasImage] = useState(false);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<OcrLine[] | null>(null);
  const [resultMeta, setResultMeta] = useState("");
  const [emptyMsg, setEmptyMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const pipelineRef = useRef<Pipeline | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const loadTokenRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setCard = useCallback((id: string, s: CardStatus) => {
    setCardStatus((prev) => ({ ...prev, [id]: s }));
  }, []);

  // ===== 模型加载 =====
  const selectModel = useCallback(
    async (entry: ModelEntry) => {
      if (currentId === entry.id && pipelineRef.current) return;
      setCurrentId(entry.id);

      const token = ++loadTokenRef.current;
      pipelineRef.current = null;
      setReady(false);
      setCard(entry.id, { text: "加载中…", kind: "" });
      setStatusText(`加载模型：${entry.name}`);
      setStatusKind("loading");

      try {
        const files = await loadModelFiles(entry, (p) => {
          if (token !== loadTokenRef.current) return;
          setModelProgress({
            pct: p.pct,
            label: `${p.label} ${Math.round(p.pct)}%${p.fromCache ? " · 缓存" : ""}`,
          });
        });
        if (token !== loadTokenRef.current) return;

        setModelProgress({ pct: 100, label: "创建推理会话…" });
        const pl = await createPipeline({
          det: files.det,
          rec: files.rec,
          dict: files.dict,
          params: entry.params,
        });
        if (token !== loadTokenRef.current) return;

        pipelineRef.current = pl;
        setModelProgress(null);
        setCard(entry.id, {
          text: files.allFromCache ? "就绪 · 已缓存" : "就绪",
          kind: "ok",
        });
        setStatusText(`模型就绪 (${pl.backend})`);
        setStatusKind("ok");
        setModelInfo(`字符集 ${pl.dictSize} · 后端 ${pl.backend}`);
        setReady(true);
      } catch (e) {
        if (token !== loadTokenRef.current) return;
        console.error(e);
        setModelProgress(null);
        setCard(entry.id, { text: "加载失败", kind: "err" });
        setStatusText("模型加载失败: " + (e as Error).message);
        setStatusKind("");
      }
    },
    [currentId, setCard],
  );

  // 启动：读清单，默认选中推荐模型
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/models.json");
        const manifest = (await resp.json()) as Manifest;
        if (cancelled) return;
        const list = manifest.models || [];
        setModels(list);
        const def = list.find((m) => m.recommended) || list[0];
        if (def) selectModel(def);
      } catch (e) {
        if (!cancelled) {
          setStatusText("模型清单加载失败: " + (e as Error).message);
          setStatusKind("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== 上传 =====
  const loadImageFile = useCallback((file: File | undefined | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        imageDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
        setHasImage(true);
        setResults(null);
        setResultMeta("");
        setEmptyMsg(null);
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
  }, []);

  // ===== 识别 =====
  const runOCR = useCallback(async () => {
    const pipeline = pipelineRef.current;
    const imageData = imageDataRef.current;
    const canvas = canvasRef.current;
    if (!pipeline || !imageData || !canvas) return;
    setRunning(true);
    setEmptyMsg(null);

    try {
      const out: OcrRunResult = await pipeline.run(imageData, (p) =>
        setRunProgress({ pct: p.pct, label: p.label }),
      );
      setRunProgress(null);

      if (out.boxesFound === 0) {
        setResults(null);
        setResultMeta("");
        setEmptyMsg("未检测到文本，请尝试更清晰的图片");
      } else {
        // 绘制标注框
        const ctx = canvas.getContext("2d")!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.putImageData(imageData, 0, 0);
        const colors = ["#00ff88", "#4c9aff", "#ff9f43", "#f368e0"];
        out.results.forEach((r, i) => {
          ctx.strokeStyle = colors[i % colors.length];
          ctx.lineWidth = 2;
          ctx.strokeRect(r.box.x0, r.box.y0, r.box.x1 - r.box.x0, r.box.y1 - r.box.y0);
        });
        setResults(out.results);
        setResultMeta(
          `共 ${out.results.length} 行 · ${Math.round(out.totalMs)}ms · ${out.backend}`,
        );
        if (out.results.length === 0) setEmptyMsg("未识别到有效文本");
      }
    } catch (e) {
      console.error(e);
      setRunProgress(null);
      setResults(null);
      setEmptyMsg("识别失败: " + (e as Error).message);
    }
    setRunning(false);
  }, []);

  // ===== 渲染 =====
  const confMax = results ? Math.max(...results.map((r) => r.confidence), 0.001) : 1;

  return (
    <div className="flex flex-col flex-1">
      {/* 头部 */}
      <header className="flex flex-wrap items-center gap-4 border-b border-border px-8 py-5">
        <h1 className="text-lg font-semibold">📄 浏览器端 OCR 验证站</h1>
        <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-xs text-accent">
          onnxruntime-web · 纯本地推理
        </span>
        <div className="ml-auto flex items-center gap-2 text-[13px] text-muted">
          <span>{statusText}</span>
          <span
            className={`h-2 w-2 rounded-full ${
              statusKind === "ok"
                ? "bg-green shadow-[0_0_8px] shadow-green"
                : statusKind === "loading"
                  ? "animate-pulse bg-yellow"
                  : "bg-muted"
            }`}
          />
        </div>
      </header>

      {/* 模型选择器 */}
      <div className="mx-auto w-full max-w-[1400px] px-8 pt-4">
        <div className="flex flex-wrap gap-3">
          {models.map((m) => {
            const st = cardStatus[m.id];
            return (
              <button
                key={m.id}
                onClick={() => selectModel(m)}
                className={`min-w-[230px] rounded-[10px] border bg-panel px-3.5 py-2.5 text-left transition-colors ${
                  currentId === m.id
                    ? "border-accent shadow-[inset_0_0_0_1px] shadow-accent"
                    : "border-border hover:border-accent"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{m.name}</span>
                  {m.recommended && (
                    <span className="rounded-full border border-green/35 bg-green/10 px-2 py-px text-[11px] text-green">
                      推荐
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted">{m.desc}</div>
                <div className="mt-1.5 flex justify-between text-[11px] text-muted">
                  <span>
                    {m.sizeMB} MB · {m.source === "local" ? "本站" : "远程"}
                  </span>
                  <span className={st?.kind === "ok" ? "text-green" : st?.kind === "err" ? "text-red" : ""}>
                    {st?.text}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        {modelProgress && (
          <div className="mt-2.5 max-w-[460px]">
            <div className="mb-1 text-[11px] text-muted">{modelProgress.label}</div>
            <div className="h-1 overflow-hidden rounded bg-border">
              <div
                className="h-full bg-accent transition-[width] duration-200"
                style={{ width: `${modelProgress.pct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 主区 */}
      <main className="mx-auto grid w-full max-w-[1400px] flex-1 grid-cols-1 gap-5 px-8 py-5 lg:grid-cols-[1.4fr_1fr]">
        {/* 图片面板 */}
        <section className="overflow-hidden rounded-xl border border-border bg-panel">
          <div className="flex items-center justify-between border-b border-border px-4 py-3 text-[13px] text-muted">
            <span>图片</span>
            <span className="text-xs">拖拽或点击上传 · 全部在本地浏览器运行，图片不上传服务器</span>
          </div>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              loadImageFile(e.dataTransfer.files[0]);
            }}
            className={`m-3 flex min-h-[420px] cursor-pointer items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
              dragOver ? "border-accent bg-accent/5" : "border-border bg-white/[.02] hover:border-accent hover:bg-accent/5"
            }`}
          >
            <canvas
              ref={canvasRef}
              className="max-h-[480px] max-w-full object-contain"
              style={{ display: hasImage ? "block" : "none" }}
            />
            {!hasImage && (
              <div className="pointer-events-none text-center text-sm leading-loose text-muted">
                <span className="mb-2 block text-[40px]">🖼️</span>
                拖拽图片到这里，或点击选择图片
                <span className="block text-xs opacity-70">支持 PNG / JPG / WebP 截图</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2.5 px-4 pb-4">
            <button
              onClick={runOCR}
              disabled={!ready || !hasImage || running}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "识别中…" : "开始识别"}
            </button>
            <span className="text-xs text-muted">{modelInfo}</span>
          </div>
        </section>

        {/* 结果面板 */}
        <section className="overflow-hidden rounded-xl border border-border bg-panel">
          <div className="flex items-center justify-between border-b border-border px-4 py-3 text-[13px] text-muted">
            <span>识别结果</span>
            <span className="text-xs">{resultMeta}</span>
          </div>
          {runProgress && (
            <div className="px-4 pb-3 pt-3">
              <div className="mb-1 text-[11px] text-muted">{runProgress.label}</div>
              <div className="h-1 overflow-hidden rounded bg-border">
                <div
                  className="h-full bg-accent transition-[width] duration-200"
                  style={{ width: `${runProgress.pct}%` }}
                />
              </div>
            </div>
          )}
          <div className="max-h-[480px] overflow-y-auto px-4 py-3">
            {results && results.length > 0 ? (
              results.map((r, i) => {
                const ratio = r.confidence / confMax;
                const cls =
                  ratio > 0.7 ? "text-green" : ratio > 0.4 ? "text-yellow" : "text-muted";
                return (
                  <div
                    key={i}
                    className="grid grid-cols-[36px_90px_1fr] items-center gap-3 rounded-lg border border-transparent px-2.5 py-2 hover:bg-white/[.03]"
                  >
                    <span className="text-center text-xs text-muted">#{i + 1}</span>
                    <span className={`text-[13px] tabular-nums ${cls}`}>
                      {(r.confidence * 100).toFixed(2)}%
                    </span>
                    <span className="break-all text-[15px]">{r.text}</span>
                  </div>
                );
              })
            ) : (
              <div className="py-[60px] text-center text-[13px] leading-loose text-muted">
                <span className="mb-2 block text-4xl">{emptyMsg ? "😕" : "🧪"}</span>
                {emptyMsg || (
                  <>
                    上传图片后点击「开始识别」
                    <br />
                    等待模型加载完成即可使用
                  </>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => loadImageFile(e.target.files?.[0])}
      />
    </div>
  );
}
