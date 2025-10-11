import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import ytdl from "@distube/ytdl-core";
import type { Readable as NodeReadable } from "stream";
import sanitize from "sanitize-filename";
import YTDlpWrap from "yt-dlp-wrap";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ffmpegPathPkg from "@ffmpeg-installer/ffmpeg";
// Cleanup function to remove any player script files created by dependencies
function cleanupPlayerScripts() {
  try {
    const root = process.cwd();
    const entries = fs.readdirSync(root);
    for (const name of entries) {
      if (/player-script\.js$/.test(name) || /-player-script\.js$/.test(name)) {
        try { fs.unlinkSync(path.join(root, name)); } catch {}
      }
    }
  } catch {}
}
// Run cleanup at import time
cleanupPlayerScripts();

function normalizeUrl(raw?: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace("/", "");
      return `https://www.youtube.com/watch?v=${id}`;
    }
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname.startsWith("/shorts/")) {
        const id = u.pathname.split("/")[2];
        return `https://www.youtube.com/watch?v=${id}`;
      }
      if (u.pathname === "/watch" && u.searchParams.get("v")) {
        return `https://www.youtube.com/watch?v=${u.searchParams.get("v")}`;
      }
    }
    return raw;
  } catch {
    return raw;
  }
}

async function getInfoWithFallback(url: string) {
  try {
    const info = await ytdl.getInfo(url);
    return { info, source: "ytdl.getInfo" as const };
  } catch (e1) {
    try {
      const info = await ytdl.getBasicInfo(url);
      return { info, source: "ytdl.getBasicInfo" as const };
    } catch (e2) {
      // Try yt-dlp JSON for formats and basic metadata
      try {
        const yt = await ensureYtDlp();
        const jsonStr = await yt.execPromise(["-J", url]);
        const json = JSON.parse(jsonStr);
        const infoLike: any = {
          videoDetails: {
            title: json.title,
            thumbnails: Array.isArray(json.thumbnails) ? json.thumbnails : [],
          },
          formats: Array.isArray(json.formats) ? json.formats.map((f: any) => ({
            itag: f.format_id,
            url: f.url,
            mimeType: f.ext ? `video/${f.ext}` : undefined,
            qualityLabel: f.format_note || (f.height ? `${f.height}p` : undefined),
            height: f.height,
            hasAudio: !!f.audio_channels || f.asr,
            hasVideo: !!f.height,
          })) : [],
        };
        return { info: infoLike, source: "yt-dlp -J" as const };
      } catch (e3) {
        throw e3;
      }
    }
  }
}

async function ensureYtDlp(): Promise<YTDlpWrap> {
  // Allow overriding via env
  const envPath = process.env.YTDLP_PATH;
  const isWin = process.platform === "win32";
  const binNames = isWin ? ["yt-dlp.exe", "yt-dlp"] : ["yt-dlp"];
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);
  // Local .bin resolution
  const binDir = path.join(process.cwd(), "node_modules", ".bin");
  for (const n of binNames) candidates.push(path.join(binDir, n));
  // Cache location
  const cacheDir = path.join(process.cwd(), "node_modules", ".cache", "yt-dlp");
  for (const n of binNames) candidates.push(path.join(cacheDir, n));

  let found: string | null = null;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) { found = p; break; }
    } catch {}
  }
  if (!found) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch {}
    // Download binary to cache dir
    const target = path.join(cacheDir, isWin ? "yt-dlp.exe" : "yt-dlp");
    await YTDlpWrap.downloadFromGithub(target);
    found = target;
  }
  const yt = new YTDlpWrap(found!);
  return yt;
}

function nodeToWebStream(node: NodeReadable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk));
      const onEnd = () => controller.close();
      const onError = (err: any) => controller.error(err);
      node.on("data", onData);
      node.once("end", onEnd);
      node.once("close", onEnd);
      node.once("error", onError);
    },
    cancel() {
      try {
        // @ts-ignore
        node.destroy?.();
      } catch {}
    },
  });
}

function qualitiesFromFormats(formats: any[]): string[] {
  const set = new Set<string>();
  for (const f of formats || []) {
    const hasVideo = f.hasVideo || (!!f.height);
    if (!hasVideo) continue;
    const label = f.qualityLabel || (f.height ? `${f.height}p` : null);
    if (label) set.add(label);
  }
  const arr = Array.from(set);
  const sorted = arr.sort((a, b) => parseInt(a) - parseInt(b));
  return sorted;
}

function fileNameFromTitle(title: string, ext: string) {
  const safe = sanitize(title || "download");
  return `${safe}.${ext}`;
}

export async function HEAD(req: Request) {
  cleanupPlayerScripts();
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("url");
  const format = searchParams.get("format") || "best";
  const url = normalizeUrl(raw);
  if (!url) return new NextResponse(JSON.stringify({ error: "Missing url" }), { status: 400 });
  try {
    const { info } = await getInfoWithFallback(url);
    if (String(format).startsWith("audio")) {
      return new NextResponse(null, { status: 200, headers: { "X-Mode": "audio" } });
    }
    const formats = (info as any).formats || [];
    const muxed = formats.find((f: any) => f.qualityLabel === format && ((f.hasAudio && f.hasVideo) || (f.acodec && f.vcodec)));
    if (muxed) return new NextResponse(null, { status: 200, headers: { "X-Mode": "muxed" } });
    // If requested format is a height that exists as video-only, we will merge via ffmpeg
    const h = parseInt(String(format).replace(/[^0-9]/g, ""), 10);
    const hasVideoOnly = !isNaN(h) && formats.some((f: any) => (f.hasVideo || f.height) && (f.height ? f.height <= h : (f.qualityLabel || "").includes(format)));
    if (hasVideoOnly || format === "best") return new NextResponse(null, { status: 200, headers: { "X-Mode": "merge" } });
    return new NextResponse(JSON.stringify({ error: "Format unavailable" }), { status: 422 });
  } catch (err: any) {
    return new NextResponse(JSON.stringify({ error: err?.message || "Unavailable" }), { status: 422 });
  }
}

export async function GET(req: Request) {
  cleanupPlayerScripts();
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("url");
  const mode = searchParams.get("mode") || "";
  const format = searchParams.get("format") || "best";
  const cookie = searchParams.get("cookie") || req.headers.get("x-youtube-cookie") || undefined;
  const url = normalizeUrl(raw);
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  if (mode === "info") {
    try {
      const { info, source } = await getInfoWithFallback(url);
      const title = (info as any)?.videoDetails?.title || "";
      const thumb = (info as any)?.videoDetails?.thumbnails?.[0]?.url || (info as any)?.thumbnail_url || "";
      let formats = (info as any).formats || [];
      // hydrate via yt-dlp if empty
      if (!formats.length) {
        try {
          const yt = await ensureYtDlp();
          const jsonStr = await yt.execPromise(["-J", url]);
          const json = JSON.parse(jsonStr);
          formats = Array.isArray(json.formats) ? json.formats.map((f: any) => ({
            itag: f.format_id,
            url: f.url,
            mimeType: f.ext ? `video/${f.ext}` : undefined,
            qualityLabel: f.format_note || (f.height ? `${f.height}p` : undefined),
            height: f.height,
            hasAudio: !!f.audio_channels || f.asr,
            hasVideo: !!f.height,
          })) : [];
        } catch {}
      }
      const qualities = qualitiesFromFormats(formats);
      return NextResponse.json({ rawTitle: title, thumbnail: thumb, availableQualities: qualities, limited: source !== "ytdl.getInfo" });
    } catch (err: any) {
      return NextResponse.json({ error: err?.message || "Failed to fetch info", detail: String(err) }, { status: 400 });
    }
  }

  // Streaming
  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept": "*/*",
    };
    if (cookie) headers["Cookie"] = cookie;

    if (format.startsWith("audio")) {
      const [, fmt] = format.split(":");
      // Use yt-dlp to extract bestaudio and ffmpeg to convert to requested format
      try {
        const yt = await ensureYtDlp();
        const tmpDir = path.join(process.cwd(), "node_modules", ".cache", "yt-dlp-audio");
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
        const titleInfo = await getInfoWithFallback(url);
        const baseName = fileNameFromTitle((titleInfo as any)?.info?.videoDetails?.title || "audio", fmt || "m4a");
        const tmpFile = path.join(tmpDir, `${Date.now()}-${baseName}`);
        const addHeaders: string[] = [
          "--add-header", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        ];
        if (cookie) addHeaders.push("--add-header", `Cookie: ${cookie}`);
        const ffArgs = ["--ffmpeg-location", ffmpegPathPkg.path];
        const postprocessors: Record<string, string[]> = {
          mp3: ["--extract-audio", "--audio-format", "mp3", "--audio-quality", "0"],
          wav: ["--extract-audio", "--audio-format", "wav"],
          m4a: ["--extract-audio", "--audio-format", "m4a"],
          opus: ["--extract-audio", "--audio-format", "opus"],
          flac: ["--extract-audio", "--audio-format", "flac"],
        };
        const pp = postprocessors[fmt || "m4a"] || postprocessors.m4a;
        const args = [
          "--no-playlist",
          "-f", "bestaudio",
          ...pp,
          ...ffArgs,
          "-o", tmpFile,
          url,
        ];
        await yt.execPromise([...addHeaders, ...args]);
        const stat = fs.statSync(tmpFile);
        const stream = fs.createReadStream(tmpFile);
        stream.once("close", () => { try { fs.unlinkSync(tmpFile); } catch {} });
        const mimeMap: Record<string, string> = {
          mp3: "audio/mpeg",
          wav: "audio/wav",
          m4a: "audio/mp4",
          opus: "audio/ogg",
          flac: "audio/flac",
        };
        const response = new Response(nodeToWebStream(stream as any) as any, {
          status: 200,
          headers: {
            "Content-Type": mimeMap[fmt || "m4a"] || "audio/mp4",
            "Content-Length": String(stat.size),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(baseName)}`,
          },
        });
        // Cleanup after responding
        cleanupPlayerScripts();
        return response;
      } catch (e: any) {
        return NextResponse.json({ error: "Audio conversion failed", detail: e?.message || String(e) }, { status: 500 });
      }
    }

    // video: try muxed via ytdl-core; else yt-dlp direct URL
    try {
      const info = await ytdl.getInfo(url);
      let target = info.formats.find((f) => f.qualityLabel === format && f.hasAudio && f.hasVideo);
      if (!target) {
        if (format === "best") {
          target = info.formats.find((f) => f.hasAudio && f.hasVideo);
        } else {
          // fallback to height match
          target = info.formats.find((f) => f.hasAudio && f.hasVideo && f.qualityLabel?.includes(format));
        }
      }
      if (target?.url) {
        // Probe upstream via HEAD to get stable Content-Length and type
        let upstreamLen: string | null = null;
        let upstreamType: string | null = null;
        try {
          const head = await fetch(target.url, { method: "HEAD", headers });
          if (head.ok) {
            upstreamLen = head.headers.get("content-length");
            upstreamType = head.headers.get("content-type");
          }
        } catch {}
        // Proxy the muxed stream with attachment headers so browsers show download manager
        const prox = await fetch(target.url, { headers });
        if (!prox.ok || !prox.body) throw new Error(`Upstream failed (${prox.status})`);
        const fileBase = fileNameFromTitle((info as any)?.videoDetails?.title || "video", "mp4");
        const len = upstreamLen || prox.headers.get("content-length");
        const response = new Response(prox.body as any, {
          status: 200,
          headers: {
            // Force octet-stream to avoid inline playback; ensure download manager
            "Content-Type": "application/octet-stream",
            ...(len ? { "Content-Length": len } : {}),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileBase)}`,
          },
        });
        cleanupPlayerScripts();
        return response;
      }
      throw new Error("No muxed format found");
    } catch (e1) {
      // yt-dlp merge fallback (bestvideo+bestaudio) via ffmpeg
      try {
        const yt = await ensureYtDlp();
        const titleInfo = await getInfoWithFallback(url);
        let query = "bestvideo+bestaudio/best";
        const h = parseInt(String(format).replace(/[^0-9]/g, ""), 10);
        if (!isNaN(h)) query = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
        const tmpDir = path.join(process.cwd(), "node_modules", ".cache", "yt-dlp-tmp");
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
        const fileBase = fileNameFromTitle(((titleInfo as any)?.info?.videoDetails?.title) || "video", "mkv");
        const tmpFile = path.join(tmpDir, `${Date.now()}-${fileBase}`);
        const args = [
          "--no-playlist",
          "-f", query,
          "--merge-output-format", "mkv",
          "--ffmpeg-location", ffmpegPathPkg.path,
          "-o", tmpFile,
        ];
        // headers: user-agent and cookie if provided
        const addHeaders: string[] = [
          "--add-header", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        ];
        if (cookie) addHeaders.push("--add-header", `Cookie: ${cookie}`);
        await yt.execPromise([...addHeaders, ...args, url]);
        const stat = fs.statSync(tmpFile);
        const stream = fs.createReadStream(tmpFile);
        // cleanup after stream ends
        stream.once("close", () => { try { fs.unlinkSync(tmpFile); } catch {} });
        const response = new Response(nodeToWebStream(stream as any) as any, {
          status: 200,
          headers: {
            "Content-Type": "video/x-matroska",
            "Content-Length": String(stat.size),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileBase)}`,
          },
        });
        cleanupPlayerScripts();
        return response;
      } catch (e2: any) {
        return NextResponse.json({ error: "Video download failed", detail: e2?.message || String(e2) }, { status: 500 });
      }
    }
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to process request", detail: err?.message || String(err) }, { status: 500 });
  }
}