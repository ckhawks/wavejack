import { useEffect } from "react";
import { Layout } from "./components/Layout";
import { useDownloadEvents } from "./hooks/useDownloadEvents";
import { useSettingsStore } from "./stores/settingsStore";

export default function App() {
  // Listen to download events from Rust backend
  useDownloadEvents();

  // Load persisted settings on mount
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return <Layout />;
}
