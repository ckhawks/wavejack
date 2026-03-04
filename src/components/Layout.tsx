import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { UrlInput } from "./UrlInput";
import { DownloadQueue } from "./DownloadQueue";
import { Settings } from "./Settings";

export function Layout() {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="flex h-full flex-col bg-black">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[#222] px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight text-white">
          Media Downloader
        </h1>
        <button
          onClick={() => setShowSettings(true)}
          className="rounded-lg p-2 text-neutral-400 transition-all duration-200 hover:bg-[#111] hover:text-white"
        >
          <SettingsIcon size={20} />
        </button>
      </header>

      {/* Main content */}
      <main className="flex flex-1 flex-col gap-6 overflow-hidden p-6">
        <UrlInput />
        <DownloadQueue />
      </main>

      {/* Settings modal */}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
