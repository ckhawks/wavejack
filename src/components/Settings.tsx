import { useState, useEffect } from "react";
import { X, FolderOpen, CheckCircle, AlertCircle, Loader } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../stores/settingsStore";
import { ensureYtdlpReady } from "../lib/commands";

interface Props {
  onClose: () => void;
}

export function Settings({ onClose }: Props) {
  const { settings, loaded, updateSetting } = useSettingsStore();
  const [cobaltUrl, setCobaltUrl] = useState("");
  const [ytdlpStatus, setYtdlpStatus] = useState<
    "unknown" | "checking" | "ready" | "downloading" | "error"
  >("unknown");
  const [ytdlpPath, setYtdlpPath] = useState("");

  // Sync local cobalt URL state when settings load
  useEffect(() => {
    if (loaded) {
      setCobaltUrl(settings.cobaltUrl);
    }
  }, [loaded, settings.cobaltUrl]);

  // Pick output directory using system folder picker
  const pickOutputDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      await updateSetting("outputDir", selected as string);
    }
  };

  // Save cobalt URL on blur
  const saveCobaltUrl = async () => {
    await updateSetting("cobaltUrl", cobaltUrl);
  };

  // Check/install yt-dlp
  const checkYtdlp = async () => {
    setYtdlpStatus("checking");
    try {
      const path = await ensureYtdlpReady();
      setYtdlpPath(path);
      setYtdlpStatus("ready");
    } catch (e) {
      console.error("yt-dlp check failed:", e);
      setYtdlpStatus("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-[#222] bg-[#111] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#222] px-6 py-4">
          <h2 className="text-base font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-neutral-400 transition-colors hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-6 p-6">
          {/* Output directory */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              Output Directory
            </label>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 truncate rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm text-white">
                {settings.outputDir || "Not set (using Downloads)"}
              </div>
              <button
                onClick={pickOutputDir}
                className="flex items-center gap-2 rounded-lg border border-[#333] px-4 py-2.5 text-sm text-neutral-400 transition-all duration-200 hover:border-[#555] hover:text-white"
              >
                <FolderOpen size={16} />
                Browse
              </button>
            </div>
          </div>

          {/* Cobalt instance URL */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              Cobalt Instance URL (optional fallback)
            </label>
            <input
              type="text"
              value={cobaltUrl}
              onChange={(e) => setCobaltUrl(e.target.value)}
              onBlur={saveCobaltUrl}
              placeholder="https://your-cobalt-instance.example.com"
              className="w-full rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-all duration-200 focus:border-[#555]"
            />
            <p className="mt-1.5 text-xs text-neutral-600">
              Self-hosted cobalt instance. Used as fallback when yt-dlp fails.
            </p>
          </div>

          {/* yt-dlp status */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              yt-dlp Status
            </label>
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm">
                {ytdlpStatus === "ready" && (
                  <>
                    <CheckCircle size={14} className="shrink-0 text-green-400" />
                    <span className="truncate text-green-400">{ytdlpPath}</span>
                  </>
                )}
                {ytdlpStatus === "checking" || ytdlpStatus === "downloading" ? (
                  <>
                    <Loader size={14} className="shrink-0 animate-spin text-blue-400" />
                    <span className="text-blue-400">
                      {ytdlpStatus === "downloading"
                        ? "Downloading yt-dlp..."
                        : "Checking..."}
                    </span>
                  </>
                ) : null}
                {ytdlpStatus === "error" && (
                  <>
                    <AlertCircle size={14} className="shrink-0 text-red-400" />
                    <span className="text-red-400">Failed to find/download yt-dlp</span>
                  </>
                )}
                {ytdlpStatus === "unknown" && (
                  <span className="text-neutral-500">Not checked yet</span>
                )}
              </div>
              <button
                onClick={checkYtdlp}
                disabled={ytdlpStatus === "checking" || ytdlpStatus === "downloading"}
                className="rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200 disabled:opacity-40"
              >
                {ytdlpStatus === "ready" ? "Re-check" : "Check / Install"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
