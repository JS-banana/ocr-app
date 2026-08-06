// 共享类型：模型清单条目与 OCR 结果

export interface ModelEntry {
  id: string;
  name: string;
  recommended?: boolean;
  sizeMB: number;
  desc: string;
  source: "local" | "remote";
  pipeline: string;
  files: { det: string; rec: string; dict: string };
  params: {
    detMaxSide: number;
    recHeight: number;
    recMaxWidth: number;
    dictSize: number;
  };
}

export interface Manifest {
  models: ModelEntry[];
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
