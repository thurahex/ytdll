import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  experimental: {},
  serverExternalPackages: [
    "@ffmpeg-installer/ffmpeg",
    "yt-dlp-wrap",
    "@distube/ytdl-core",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externals = config.externals as any[] | undefined;
      config.externals = Array.isArray(externals)
        ? [...externals, "@ffmpeg-installer/ffmpeg", "yt-dlp-wrap"]
        : ["@ffmpeg-installer/ffmpeg", "yt-dlp-wrap"];
    }
    return config;
  },
};

export default nextConfig;
