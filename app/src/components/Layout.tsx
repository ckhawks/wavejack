import { useState } from "react";
import { Settings as SettingsIcon, Minus, Square, X, Download, Radio, Library, Compass } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { UrlInput } from "./UrlInput";
import { DownloadQueue } from "./DownloadQueue";
import { Settings } from "./Settings";
import { AudioPlayer } from "./AudioPlayer";
import { usePlayerStore } from "../stores/playerStore";
import { useRoomStore } from "../stores/roomStore";
import { RoomBrowser } from "./rooms/RoomBrowser";
import { RoomView } from "./rooms/RoomView";
import { LibraryView } from "./LibraryView";
import { DiscoverView } from "./discover/DiscoverView";

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

type Tab = "downloads" | "library" | "discover" | "rooms";

export function Layout() {
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("downloads");
  const hasPlayer = usePlayerStore((s) => s.currentTrack !== null);
  const currentRoomId = useRoomStore((s) => s.currentRoomId);

  const tabs: Array<{ id: Tab; label: string; icon: typeof Download }> = [
    { id: "downloads", label: "Downloads", icon: Download },
    { id: "library", label: "Library", icon: Library },
    { id: "discover", label: "Discover", icon: Compass },
    { id: "rooms", label: "Rooms", icon: Radio },
  ];

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
            Wavejack
          </h1>

          {/* Tabs */}
          <nav className="flex gap-1">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
                  activeTab === id
                    ? "bg-[#222] text-white"
                    : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </nav>
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

      {/* Content area */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {activeTab === "downloads" ? (
          <main className={`flex flex-1 flex-col gap-6 overflow-hidden p-6 ${hasPlayer ? "pb-36" : ""}`}>
            <UrlInput />
            <DownloadQueue />
          </main>
        ) : activeTab === "library" ? (
          <main className={`flex flex-1 flex-col overflow-hidden pt-6 ${hasPlayer ? "pb-36" : ""}`}>
            <LibraryView />
          </main>
        ) : activeTab === "discover" ? (
          <main className={`flex flex-1 flex-col overflow-hidden p-6 ${hasPlayer ? "pb-36" : ""}`}>
            <DiscoverView />
          </main>
        ) : currentRoomId ? (
          <RoomView />
        ) : (
          <main className="flex flex-1 flex-col overflow-hidden p-6">
            <RoomBrowser />
          </main>
        )}

        {/* Settings modal */}
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}

        {/* Audio player footer (on downloads + library tabs) */}
        {activeTab !== "rooms" && <AudioPlayer />}
      </div>
    </div>
  );
}
