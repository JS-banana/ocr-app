// 共享类型：校验后的模型清单、公共 OCR 结果与 Pipeline 接口

export interface AssetFile {
  url: string;
  sizeBytes: number;
}

export interface PpocrParams {
  detMaxSide: number;
  recHeight: number;
  recMaxWidth: number;
  dictSize: number;
  colorOrder: "BGR";
  detThresh: number;
  boxThresh: number;
  unclipRatio: number;
  minBoxSide: number;
}

export interface PpocrFiles {
  det: AssetFile;
  rec: AssetFile;
  dict: AssetFile;
}

/** PP-OCR DBNet+CTC 清单条目（pipeline 判别联合的当前唯一成员） */
export interface PpocrModelEntry {
  id: string;
  name: string;
  label: string;
  recommended: boolean;
  revision: string;
  pipeline: "ppocr-dbnet-ctc";
  files: PpocrFiles;
  params: PpocrParams;
}

export type ModelEntry = PpocrModelEntry;

export interface ValidatedModelCatalog {
  models: ModelEntry[];
}

/** 向 UI 投影的摘要；downloadBytes 由 files.*.sizeBytes 求和派生 */
export interface ModelSummary {
  id: string;
  name: string;
  label: string;
  recommended: boolean;
  downloadBytes: number;
}

export interface ModelLoadProgress {
  /** 0–100；无法确定总大小时为 null（不定进度） */
  pct: number | null;
  label: string;
  fromCache: boolean;
}

export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  box: OcrBox;
  text: string;
  confidence: number;
}

export interface OcrRunResult {
  results: OcrLine[];
  boxesFound: number;
  detMs: number;
  recMs: number;
  totalMs: number;
  backend: string;
}

export type ProgressFn = (p: { pct: number; label: string }) => void;

/** 公共 Pipeline 接口：无 dictSize（PP-OCR 内容不变量仅在 factory 内校验） */
export interface OcrPipeline {
  readonly backend: string;
  run(image: ImageData, onProgress?: ProgressFn): Promise<OcrRunResult>;
  dispose(): Promise<void>;
}
