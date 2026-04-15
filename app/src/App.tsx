import { useEffect } from "react";
import { Layout } from "./components/Layout";
import { useDownloadEvents } from "./hooks/useDownloadEvents";
import { useDiscoverEvents } from "./hooks/useDiscoverEvents";
import { useRemoteEvents } from "./hooks/useRemoteEvents";
import { useSettingsStore } from "./stores/settingsStore";
import { useDownloadStore } from "./stores/downloadStore";
import { usePlayerStore } from "./stores/playerStore";
import { useLibraryStore } from "./stores/libraryStore";
import { listen } from "@tauri-apps/api/event";

export default function App() {
  // Listen to download and discover events from Rust backend
  useDownloadEvents();
  useDiscoverEvents();
  useRemoteEvents();

  // Load persisted settings and download history on mount
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadHistory = useDownloadStore((s) => s.loadHistory);
  const loadVolume = usePlayerStore((s) => s.loadVolume);
  const initLibrary = useLibraryStore((s) => s.init);
  const refreshLibrary = useLibraryStore((s) => s.refresh);
  useEffect(() => {
    loadSettings();
    loadHistory();
    loadVolume();
    initLibrary();
    const unlisten = listen("library-updated", () => {
      refreshLibrary();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadSettings, loadHistory, loadVolume, initLibrary, refreshLibrary]);

  return <Layout />;
}
