import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Ensure correct workspace root for file tracing on Vercel
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: [
    "@ffmpeg-installer/ffmpeg",
    "yt-dlp-wrap",
    "@distube/ytdl-core",
    "fluent-ffmpeg",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externals = config.externals as any[] | undefined;
      const add = ["@ffmpeg-installer/ffmpeg", "yt-dlp-wrap", "fluent-ffmpeg"];
      config.externals = Array.isArray(externals) ? [...externals, ...add] : add;
    }
    return config;
  },
};

export default nextConfig;
