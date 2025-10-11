"use client";
import { useEffect, useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [thumbnail, setThumbnail] = useState("");
  const [qualities, setQualities] = useState<string[]>([]);
  const [format, setFormat] = useState("720p");
  const [downloading, setDownloading] = useState(false);
  const [lastDlUrl, setLastDlUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [showModal, setShowModal] = useState(false);
  const [modalStage, setModalStage] = useState<"idle"|"starting"|"downloading"|"done"|"error">("idle");

  const fetchInfo = async () => {
    setError(null);
    setLoading(true);
    if (!url) {
      setError("Please paste a YouTube URL.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/download?mode=info&url=${encodeURIComponent(url)}`);
      const data = await res.json();
      setLoading(false);
      if (!res.ok) throw new Error(data.error || "Failed to fetch info");
      setTitle(data.rawTitle || "");
      setThumbnail(data.thumbnail || "");
      const qs = Array.isArray(data.availableQualities) ? data.availableQualities : [];
      setQualities(qs);
      // Respect current selection if valid; else default to highest
      if (qs.length) {
        setFormat((prev) => (qs.includes(prev) || String(prev).startsWith("audio")) ? prev : qs[qs.length - 1]);
      }
    } catch (err: any) {
      setLoading(false);
      setError(err?.message || "Failed to load info");
    }
  };

  const startDownload = async () => {
    setError(null);
    setStatus("");
    if (!url) {
      setError("Please paste a YouTube URL.");
      return;
    }
    const dlUrl = `/api/download?url=${encodeURIComponent(url)}&format=${encodeURIComponent(format)}`;
    setDownloading(true);
    try {
      setShowModal(true);
      setModalStage("starting");
      // Stream the file in-page to know exact completion
      setStatus("Starting download...");
      // Optional: preflight HEAD to detect availability quickly
      try { await fetch(dlUrl, { method: "HEAD" }); } catch {}
      const res = await fetch(dlUrl);
      if (!res.ok || !res.body) throw new Error("Download failed to start");
      setModalStage("downloading");
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const blob = new Blob(chunks, { type: res.headers.get("content-type") || "application/octet-stream" });
      const cd = res.headers.get("content-disposition") || "";
      let filename = "download";
      try {
        const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const basic = /filename="?([^";]+)"?/i.exec(cd);
        if (star && star[1]) filename = decodeURIComponent(star[1]);
        else if (basic && basic[1]) filename = basic[1];
      } catch {}
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch {} }, 4000);
      setLastDlUrl(dlUrl);
      setStatus("Downloaded");
      setModalStage("done");
    } catch (err: any) {
      setError(err?.message || "Download failed");
      setStatus("");
      setModalStage("error");
      setShowModal(true);
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    const id = setTimeout(() => { if (url) fetchInfo(); }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100">
      <div className="max-w-3xl mx-auto pt-6 px-4 md:px-0">
        <header className="text-center mb-8">
          <h1 className="text-3xl font-bold">YouTube Downloader</h1>
          <p className="text-slate-400 mt-2">Paste a URL, pick a format, and download.</p>
        </header>

        <div className="bg-slate-800 rounded-xl shadow-lg p-6">
          <label className="block text-sm font-medium mb-2" htmlFor="url">YouTube URL</label>
          <div className="flex gap-2 flex-col sm:flex-row">
            <input
              id="url"
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              className="flex-1 rounded-lg bg-slate-700 border border-slate-600 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          {thumbnail || title ? (
            <div className="mt-4">
              <div className="grid md:grid-cols-[auto,1fr] items-start gap-4">
                {thumbnail ? (
                  <img src={thumbnail} alt="thumbnail" className="w-24 h-16 rounded object-cover border border-slate-700" />
                ) : null}
                <div>
                  <div className="font-semibold">{title}</div>
                  <div className="text-xs text-slate-400 mt-1">Available: {qualities.join(', ')}</div>
                </div>
              </div>
              {/* Removed iframe preview for stability; showing thumbnail only */}
            </div>
          ) : null}

          <label className="block text-sm font-medium mt-6 mb-2" htmlFor="format">Format</label>
          <select
            id="format"
            className="w-full rounded-lg bg-slate-700 border border-slate-600 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            {qualities.length ? (
              qualities.map((q) => (<option key={q} value={q}>{q}</option>))
            ) : (
              ["360p", "720p", "1080p"].map((q) => (<option key={q} value={q}>{q}</option>))
            )}
            <optgroup label="Audio">
              <option value="audio:mp3">Audio (MP3)</option>
              <option value="audio:wav">Audio (WAV)</option>
              <option value="audio:m4a">Audio (M4A)</option>
              <option value="audio:opus">Audio (Opus)</option>
              <option value="audio:flac">Audio (FLAC)</option>
            </optgroup>
          </select>

          <button
            onClick={startDownload}
            disabled={downloading || !url}
            className={`mt-6 w-full rounded-lg px-4 py-2 font-semibold transition-colors ${downloading || !url ? "bg-green-700 cursor-not-allowed" : "bg-green-600 hover:bg-green-500"}`}
          >
            {downloading ? "Starting…" : "Download"}
          </button>

          {status ? (
            <div className="mt-2 text-xs text-slate-300">{status}</div>
          ) : null}

          {/* Progress bar removed per request */}

          {lastDlUrl ? (
            <div className="mt-3 text-xs text-slate-400">
              If your download didn’t start, use the
              <a href={lastDlUrl} target="_blank" rel="noopener" className="ml-1 underline text-indigo-400 hover:text-indigo-300">direct link</a>.
            </div>
          ) : null}

          {loading ? (
            <div className="mt-4">
              <div className="flex items-center gap-2 text-slate-300">
                <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                </svg>
                <span>Fetching...</span>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mt-4 text-red-400 text-sm">{error}</div>
          ) : null}
        </div>
        {showModal ? (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-[90%] max-w-sm shadow-xl">
              <div className="flex items-center gap-3">
                {modalStage === "starting" ? (
                  <div className="h-4 w-4 rounded-full bg-indigo-500 animate-pulse" />
                ) : modalStage === "downloading" ? (
                  <svg className="h-5 w-5 animate-spin text-indigo-400" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                    <path d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor" className="opacity-75" />
                  </svg>
                ) : modalStage === "done" ? (
                  <svg className="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor"><path d="M16.707 5.293a1 1 0 00-1.414 0L8 12.586 4.707 9.293a1 1 0 10-1.414 1.414l4 4a1 1 0 001.414 0l8-8a1 1 0 000-1.414z"/></svg>
                ) : (
                  <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm-1-5h2v2H9v-2zm0-8h2v6H9V5z"/></svg>
                )}
                <div className="font-semibold">
                  {modalStage === "starting" && "Preparing download…"}
                  {modalStage === "downloading" && "Downloading…"}
                  {modalStage === "done" && "Done — check your downloads"}
                  {modalStage === "error" && "Download failed"}
                </div>
              </div>
              <div className="mt-3 text-xs text-slate-300">{status || (modalStage === "done" ? "Your file should be downloading now." : "")}</div>
              <div className="mt-5 flex justify-end gap-2">
                {modalStage === "done" ? (
                  <button onClick={() => { setShowModal(false); setModalStage("idle"); }} className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600">Close</button>
                ) : (
                  <button onClick={() => { setShowModal(false); setModalStage("idle"); }} className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600">Hide</button>
                )}
                {lastDlUrl ? (
                  <a href={lastDlUrl} target="_blank" rel="noopener" className="px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500">Open Direct Link</a>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
