import { useState } from "react";
import { Settings as SettingsIcon, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { UrlInput } from "./UrlInput";
import { DownloadQueue } from "./DownloadQueue";
import { Settings } from "./Settings";
import { AudioPlayer } from "./AudioPlayer";
import { usePlayerStore } from "../stores/playerStore";

function WindowControls() {
  const appWindow = getCurrentWindow();

  return (
    <div className="flex">
      <button
        onClick={() => appWindow.minimize()}
        className="flex h-8 w-10 items-center justify-center text-neutral-400 hover:bg-[#222] hover:text-white"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={() => appWindow.toggleMaximize()}
        className="flex h-8 w-10 items-center justify-center text-neutral-400 hover:bg-[#222] hover:text-white"
      >
        <Square size={10} />
      </button>
      <button
        onClick={() => appWindow.close()}
        className="flex h-8 w-10 items-center justify-center text-neutral-400 hover:bg-red-600 hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function Layout() {
  const [showSettings, setShowSettings] = useState(false);
  const hasPlayer = usePlayerStore((s) => s.currentTrack !== null);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg bg-black">
      {/* Custom title bar */}
      <header
        data-tauri-drag-region
        className="flex shrink-0 select-none items-center justify-between border-b border-[#222]"
      >
        <div data-tauri-drag-region className="flex flex-1 items-center gap-3 px-4 py-2">
          <h1
            data-tauri-drag-region
            className="text-sm font-semibold tracking-tight text-white"
          >
            Siphon
          </h1>
        </div>
        <div className="flex items-center">
          <button
            onClick={() => setShowSettings(true)}
            className="flex h-8 w-8 items-center justify-center text-neutral-400 transition-colors hover:bg-[#222] hover:text-white"
          >
            <SettingsIcon size={14} />
          </button>
          <WindowControls />
        </div>
      </header>

      {/* Content area — relative so Settings overlay stays below title bar */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <main className={`flex flex-1 flex-col gap-6 overflow-hidden p-6 ${hasPlayer ? "pb-22" : ""}`}>
          <UrlInput />
          <DownloadQueue />
        </main>

        {/* Settings modal */}
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}

        {/* Audio player footer */}
        <AudioPlayer />
      </div>
    </div>
  );
}
