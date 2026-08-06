import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 纯静态导出：产物 out/ 由 nginx/Cloudflare 分发，无服务端逻辑
  output: "export",
  // 静态导出不支持默认 Image Optimization；图片均为用户本地上传，无需优化管线
  images: { unoptimized: true },
};

export default nextConfig;
