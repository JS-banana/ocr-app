"use client";

import dynamic from "next/dynamic";

// onnxruntime-web 对 node 显式禁用，必须在客户端隔离加载（官方 e2e 同款写法）
const OcrClient = dynamic(() => import("@/components/ocr-client"), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center text-muted text-sm">
      加载中…
    </div>
  ),
});

export default function Home() {
  return <OcrClient />;
}
