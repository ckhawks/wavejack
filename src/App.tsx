import { useEffect } from "react";
import { Layout } from "./components/Layout";
import { useDownloadEvents } from "./hooks/useDownloadEvents";
import { useSettingsStore } from "./stores/settingsStore";
import { useDownloadStore } from "./stores/downloadStore";

export default function App() {
  // Listen to download events from Rust backend
  useDownloadEvents();

  // Load persisted settings and download history on mount
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadHistory = useDownloadStore((s) => s.loadHistory);
  useEffect(() => {
    loadSettings();
    loadHistory();
  }, [loadSettings, loadHistory]);

  return <Layout />;
}
