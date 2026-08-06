import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "浏览器端 OCR 验证站",
  description: "所有推理在浏览器本地完成：PP-OCR + onnxruntime-web",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
