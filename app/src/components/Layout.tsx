import { useState, useEffect } from "react";
import { Settings as SettingsIcon, Minus, Square, X, Download, Radio, Library, Compass, Rss, Home, Clock, Gamepad2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { UrlInput } from "./UrlInput";
import { DownloadQueue } from "./DownloadQueue";
import { Settings } from "./Settings";
import { AudioPlayer } from "./AudioPlayer";
import { usePlayerStore } from "../stores/playerStore";
import { useRoomStore } from "../stores/roomStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useNavStore, type Tab } from "../stores/navStore";
import { RoomBrowser } from "./rooms/RoomBrowser";
import { RoomView } from "./rooms/RoomView";
import { LibraryView } from "./LibraryView";
import { RecentlyPlayedView } from "./RecentlyPlayedView";
import { DiscoverView } from "./discover/DiscoverView";
import { FeedView } from "./FeedView";
import { HomeView } from "./HomeView";
import { GuessGameView } from "./GuessGameView";

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

const VALID_TABS: Tab[] = ["home", "downloads", "library", "recent", "discover", "feed", "rooms", "extras"];

export function Layout() {
  const [showSettings, setShowSettings] = useState(false);
  const activeTab = useNavStore((s) => s.activeTab);
  const setActiveTab = useNavStore((s) => s.setActiveTab);
  const hasPlayer = usePlayerStore((s) => s.currentTrack !== null);
  const currentRoomId = useRoomStore((s) => s.currentRoomId);
  const settings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.loaded);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  // Restore last tab on startup
  useEffect(() => {
    if (!loaded) return;
    const saved = settings.lastTab;
    if (saved && VALID_TABS.includes(saved as Tab)) {
      setActiveTab(saved as Tab);
    }
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist tab changes (covers both switchTab and external setActiveTab calls)
  useEffect(() => {
    if (loaded) updateSetting("lastTab", activeTab);
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchTab = (tab: Tab) => {
    setActiveTab(tab);
  };

  const tabs: Array<{ id: Tab; label: string; icon: typeof Download }> = [
    { id: "home", label: "Home", icon: Home },
    { id: "downloads", label: "Downloads", icon: Download },
    { id: "library", label: "Library", icon: Library },
    { id: "recent", label: "Recent", icon: Clock },
    { id: "discover", label: "Discover", icon: Compass },
    { id: "feed", label: "Feed", icon: Rss },
    { id: "rooms", label: "Rooms", icon: Radio },
    { id: "extras", label: "Extras", icon: Gamepad2 },
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
          <nav className="flex items-center gap-1">
            {tabs.map(({ id, label, icon: Icon }) => (
              <div key={id} className="flex items-center gap-1">
                {id === "rooms" && (
                  <div className="mx-1 h-4 w-px bg-[#333]" aria-hidden />
                )}
                <button
                  onClick={() => switchTab(id)}
                  className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
                    activeTab === id
                      ? "bg-[#222] text-white"
                      : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  <Icon size={12} />
                  {label}
                </button>
              </div>
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
        {activeTab === "home" ? (
          <main className={`flex flex-1 flex-col overflow-hidden ${hasPlayer ? "pb-36" : ""}`}>
            <HomeView />
          </main>
        ) : activeTab === "downloads" ? (
          <main className={`flex flex-1 flex-col gap-6 overflow-hidden p-6 ${hasPlayer ? "pb-36" : ""}`}>
            <UrlInput />
            <DownloadQueue />
          </main>
        ) : activeTab === "library" ? (
          <main className={`flex flex-1 flex-col overflow-hidden ${hasPlayer ? "pb-36" : ""}`}>
            <LibraryView />
          </main>
        ) : activeTab === "recent" ? (
          <main className={`flex flex-1 flex-col overflow-hidden ${hasPlayer ? "pb-36" : ""}`}>
            <RecentlyPlayedView />
          </main>
        ) : activeTab === "discover" ? (
          <main className={`flex flex-1 flex-col overflow-hidden p-6 ${hasPlayer ? "pb-36" : ""}`}>
            <DiscoverView />
          </main>
        ) : activeTab === "feed" ? (
          <main className={`flex flex-1 flex-col overflow-hidden p-6 ${hasPlayer ? "pb-36" : ""}`}>
            <FeedView />
          </main>
        ) : activeTab === "extras" ? (
          <main className="flex flex-1 flex-col overflow-hidden">
            <GuessGameView />
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

        {/* Audio player footer. Hidden on rooms (own transport) and extras (the
            guessing game drives the player itself and wants a clean stage). */}
        {activeTab !== "rooms" && activeTab !== "extras" && <AudioPlayer />}
      </div>
    </div>
  );
}
