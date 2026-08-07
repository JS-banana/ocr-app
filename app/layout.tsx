import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "本地 OCR · 图片文字识别",
  description: "粘贴、拖入或选择图片，识别过程完全在本机完成",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
