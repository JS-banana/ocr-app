// OCR Runtime：模型生命周期的唯一所有者。
// 状态机：unloaded → loading(Promise 去重) → ready(Pipeline)；failed 保留错误供重试。
// selection generation 决定最后一次选择；Session 创建/释放经 transition lock 串行化，
// 进入与离开临界区双重检查，保证 Medium 独占与 stale 立即 dispose。
// Node 可导入：模块无相对路径值导入。loadAssets 由组合根（UI/测试）显式注入；
// createPipeline 缺省时经动态 import 触达当前唯一 PP-OCR factory（仅浏览器执行），
// 测试注入替身后不会 import onnxruntime-web。
import type {
  AssetFile,
  ModelLoadProgress,
  OcrPipeline,
  OcrRunResult,
  PpocrModelEntry,
  ProgressFn,
  ValidatedModelCatalog,
} from "./types";

export type ModelPhase = "unloaded" | "loading" | "ready" | "failed";

/** 向 UI 投影的单模型状态快照 */
export interface ModelState {
  phase: ModelPhase;
  /** phase=ready 时的实际推理后端 */
  backend: string | null;
  /** phase=ready 时记录资产来源（cache/network/mixed） */
  source: "cache" | "network" | "mixed" | null;
  /** phase=failed 时的可读错误 */
  error: string | null;
}

export class StaleSelectionError extends Error {
  constructor() {
    super("本次选择已被更新的选择取代");
    this.name = "StaleSelectionError";
  }
}

export class RuntimeBusyError extends Error {
  constructor() {
    super("识别进行中，无法切换模型");
    this.name = "RuntimeBusyError";
  }
}

export class RuntimeClosedError extends Error {
  constructor() {
    super("Runtime 已关闭");
    this.name = "RuntimeClosedError";
  }
}

type LoadAssetsFn = (
  files: Readonly<Record<string, AssetFile>>,
  revision: string,
  onProgress?: (progress: ModelLoadProgress) => void,
) => Promise<{
  files: Record<string, ArrayBuffer>;
  source: "cache" | "network" | "mixed";
}>;

type CreatePipelineFn = (
  entry: PpocrModelEntry,
  files: Record<"det" | "rec" | "dict", ArrayBuffer>,
) => Promise<OcrPipeline>;

export interface OcrRuntimeOptions {
  catalog: ValidatedModelCatalog;
  /** 纯字节 loader（浏览器为真实 Cache API loader；测试注入替身） */
  loadAssets: LoadAssetsFn;
  /** 缺省动态 import 当前唯一 PP-OCR factory；测试注入替身 */
  createPipeline?: CreatePipelineFn;
  /** 独占运行内存的模型 id；默认 ppocrv6-medium */
  exclusiveIds?: ReadonlySet<string>;
  onState?: (id: string, state: ModelState) => void;
  onLoadProgress?: (id: string, progress: ModelLoadProgress) => void;
}

interface Slot {
  entry: PpocrModelEntry;
  phase: ModelPhase;
  pipeline: OcrPipeline | null;
  backend: string | null;
  source: "cache" | "network" | "mixed" | null;
  error: string | null;
  /** 进行中的共享加载 Promise（去重）；null 表示无在途加载 */
  load: Promise<OcrPipeline> | null;
}

/** 默认 factory：仅在浏览器真实创建 Session 时才动态触达 onnxruntime-web */
const defaultCreatePipeline: CreatePipelineFn = async (entry, files) => {
  const mod = await import("./pipelines/ppocr-dbnet-ctc");
  return mod.createPpocrPipeline(entry, files);
};

function readableError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function safeDispose(p: OcrPipeline): Promise<void> {
  try {
    await p.dispose();
  } catch (e) {
    console.warn("[runtime] pipeline dispose 失败:", readableError(e));
  }
}

export class OcrRuntime {
  private readonly slots = new Map<string, Slot>();
  private readonly exclusive: ReadonlySet<string>;
  private readonly loadAssetsFn: LoadAssetsFn;
  private readonly createPipelineFn: CreatePipelineFn;
  private readonly onState?: (id: string, state: ModelState) => void;
  private readonly onLoadProgress?: (
    id: string,
    progress: ModelLoadProgress,
  ) => void;

  private selected: string | null = null;
  private generation = 0;
  private busy = false;
  private closed = false;
  private transitionChain: Promise<void> = Promise.resolve();
  private currentRun: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(opts: OcrRuntimeOptions) {
    for (const entry of opts.catalog.models) {
      this.slots.set(entry.id, {
        entry,
        phase: "unloaded",
        pipeline: null,
        backend: null,
        source: null,
        error: null,
        load: null,
      });
    }
    this.exclusive = opts.exclusiveIds ?? new Set(["ppocrv6-medium"]);
    // 独占 id 与 manifest id 是两处数据源：未知 id 直接失败，避免独占策略静默失效
    for (const id of this.exclusive) {
      if (!this.slots.has(id)) {
        throw new Error(`exclusiveIds 含未知模型 id: ${id}`);
      }
    }
    this.loadAssetsFn = opts.loadAssets;
    this.createPipelineFn = opts.createPipeline ?? defaultCreatePipeline;
    this.onState = opts.onState;
    this.onLoadProgress = opts.onLoadProgress;
  }

  ids(): string[] {
    return [...this.slots.keys()];
  }

  selectedId(): string | null {
    return this.selected;
  }

  isBusy(): boolean {
    return this.busy;
  }

  isClosed(): boolean {
    return this.closed;
  }

  state(id: string): ModelState {
    const s = this.slotOf(id);
    return {
      phase: s.phase,
      backend: s.backend,
      source: s.source,
      error: s.error,
    };
  }

  private slotOf(id: string): Slot {
    const s = this.slots.get(id);
    if (!s) throw new Error(`未知模型 id: ${id}`);
    return s;
  }

  private setPhase(slot: Slot, phase: ModelPhase, error: string | null = null) {
    slot.phase = phase;
    slot.error = error;
    this.onState?.(slot.entry.id, this.state(slot.entry.id));
  }

  /** Session 创建/释放串行化；链本身吞错不断链 */
  private enqueueTransition<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.transitionChain.then(fn);
    this.transitionChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async releaseSlot(slot: Slot): Promise<void> {
    const p = slot.pipeline;
    slot.pipeline = null;
    slot.backend = null;
    slot.source = null;
    if (slot.phase === "ready") this.setPhase(slot, "unloaded");
    if (p) await safeDispose(p);
  }

  /**
   * 常驻策略（必须在 transition lock 内调用）：
   * 目标为独占模型 → 释放其他所有 ready Session；
   * 目标非独占 → 释放 ready 的独占模型（离开 Medium）。
   * 非独占模型之间（Tiny ↔ Small）不互踢。
   */
  private async releaseForResidency(targetId: string): Promise<void> {
    const targetExclusive = this.exclusive.has(targetId);
    for (const s of this.slots.values()) {
      if (s.entry.id === targetId || !s.pipeline) continue;
      if (targetExclusive || this.exclusive.has(s.entry.id)) {
        await this.releaseSlot(s);
      }
    }
  }

  /** 目标已 ready 的快捷路径也需维护独占不变量（防御性，正常流程不会残留） */
  private async enforceResidency(targetId: string): Promise<void> {
    const targetExclusive = this.exclusive.has(targetId);
    const needsRelease = [...this.slots.values()].some(
      (s) =>
        s.entry.id !== targetId &&
        s.pipeline &&
        (targetExclusive || this.exclusive.has(s.entry.id)),
    );
    if (!needsRelease) return;
    await this.enqueueTransition(async () => {
      if (this.selected !== targetId || this.closed) return;
      await this.releaseForResidency(targetId);
    });
  }

  /**
   * 选择模型并等待就绪。并发选择同一模型共享同一加载 Promise（下载与 Session
   * 创建只发生一次），但除最后一次外的调用一律以 StaleSelectionError 拒绝——
   * 包括同模型的先到调用（语义上它们同样"已被更新的选择取代"）。
   */
  async select(id: string): Promise<OcrPipeline> {
    if (this.closed) throw new RuntimeClosedError();
    if (this.busy) throw new RuntimeBusyError();
    const slot = this.slotOf(id);
    if (slot.phase === "failed") this.setPhase(slot, "unloaded");

    const alreadyReady = slot.phase === "ready" && slot.pipeline !== null;
    this.selected = id;
    const gen = ++this.generation;

    try {
      let pipeline: OcrPipeline;
      if (alreadyReady) {
        // 已就绪快捷路径：仍需在锁内维护独占不变量（防御性）
        await this.enforceResidency(id);
        if (!slot.pipeline) throw new Error(`模型 ${id} 就绪态被意外释放`);
        pipeline = slot.pipeline;
      } else {
        pipeline = await this.ensurePipeline(slot);
      }
      if (this.closed) throw new RuntimeClosedError();
      if (gen !== this.generation) throw new StaleSelectionError();
      return pipeline;
    } catch (e) {
      if (this.closed) throw new RuntimeClosedError();
      if (gen !== this.generation || e instanceof StaleSelectionError) {
        throw new StaleSelectionError();
      }
      throw e;
    }
  }

  /** 共享加载去重：ready 直接复用；在途 load 直接挂接；否则启动新加载 */
  private ensurePipeline(slot: Slot): Promise<OcrPipeline> {
    if (slot.phase === "ready" && slot.pipeline) {
      return Promise.resolve(slot.pipeline);
    }
    if (!slot.load) {
      const p = this.doLoad(slot);
      slot.load = p;
      p.then(
        () => {
          if (slot.load === p) slot.load = null;
        },
        () => {
          if (slot.load === p) slot.load = null;
        },
      );
    }
    return slot.load;
  }

  private settleAfterLoadAbort(slot: Slot) {
    // 加载被 stale/closed 打断：不标 failed，回到 unloaded（除非已被更新的加载接替）
    if (slot.phase === "loading") this.setPhase(slot, "unloaded");
  }

  private async doLoad(slot: Slot): Promise<OcrPipeline> {
    const id = slot.entry.id;
    this.setPhase(slot, "loading");

    let loaded: Awaited<ReturnType<LoadAssetsFn>>;
    try {
      // PpocrFiles 是 interface（无索引签名），展开为字面量后匹配 Record 形态
      const { det, rec, dict } = slot.entry.files;
      loaded = await this.loadAssetsFn(
        { det, rec, dict },
        slot.entry.revision,
        (p) => this.onLoadProgress?.(id, p),
      );
    } catch (e) {
      if (this.selected === id && !this.closed) {
        this.setPhase(slot, "failed", readableError(e));
      } else {
        this.settleAfterLoadAbort(slot);
      }
      throw e;
    }

    // 锁外快速短路：stale 资产加载不创建 Session
    if (this.selected !== id || this.closed) {
      this.settleAfterLoadAbort(slot);
      throw new StaleSelectionError();
    }

    let pipeline: OcrPipeline | null;
    try {
      pipeline = await this.enqueueTransition(async () => {
        // 进入临界区双检
        if (this.selected !== id || this.closed) return null;
        await this.releaseForResidency(id);
        const files = loaded.files as Record<"det" | "rec" | "dict", ArrayBuffer>;
        const p = await this.createPipelineFn(slot.entry, files);
        // 离开临界区双检：创建完成但已过期 → 立即 dispose
        if (this.selected !== id || this.closed) {
          await safeDispose(p);
          return null;
        }
        return p;
      });
    } catch (e) {
      if (this.selected === id && !this.closed) {
        this.setPhase(slot, "failed", readableError(e));
      } else {
        this.settleAfterLoadAbort(slot);
      }
      throw e;
    }

    if (!pipeline) {
      this.settleAfterLoadAbort(slot);
      throw new StaleSelectionError();
    }
    slot.pipeline = pipeline;
    slot.backend = pipeline.backend;
    slot.source = loaded.source;
    this.setPhase(slot, "ready");
    return pipeline;
  }

  /** 固定当前 Pipeline 运行；运行期间 select() 由 runtime 拒绝 */
  async run(image: ImageData, onProgress?: ProgressFn): Promise<OcrRunResult> {
    if (this.closed) throw new RuntimeClosedError();
    if (this.busy) throw new RuntimeBusyError();
    const id = this.selected;
    if (!id) throw new Error("尚未选择模型");
    const slot = this.slotOf(id);
    if (slot.phase !== "ready" || !slot.pipeline) {
      throw new Error(`模型未就绪: ${id}（${slot.phase}）`);
    }
    this.busy = true;
    const tracked = slot.pipeline.run(image, onProgress);
    this.currentRun = tracked.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await tracked;
    } finally {
      this.busy = false;
      this.currentRun = null;
    }
  }

  /**
   * 关闭 runtime：先标记 closed（拒绝新 select/run），等待在途 load/run/transition
   * 收口后释放全部 ready Pipeline。重复调用安全；pending load 不得在卸载后复活。
   */
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    this.closed = true;
    this.selected = null;
    this.generation++;

    const pendingLoads = [...this.slots.values()]
      .map((s) => s.load)
      .filter((p): p is Promise<OcrPipeline> => p !== null);
    await Promise.allSettled([...pendingLoads, this.currentRun]);
    await this.transitionChain;

    for (const s of this.slots.values()) {
      await this.releaseSlot(s);
      if (s.phase === "loading") this.setPhase(s, "unloaded");
    }
  }
}
