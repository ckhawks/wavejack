import { create } from "zustand";
import type { AppSettings } from "../lib/types";
import { getSettings, setSetting } from "../lib/commands";

interface SettingsStore {
  settings: AppSettings;
  loaded: boolean;
  loadSettings: () => Promise<void>;
  updateSetting: (key: keyof AppSettings, value: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: {
    outputDir: "",
    cobaltUrl: "",
    format: "mp4",
  },
  loaded: false,

  loadSettings: async () => {
    try {
      const settings = await getSettings();
      set({ settings, loaded: true });
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  },

  updateSetting: async (key, value) => {
    await setSetting(key, value);
    set({ settings: { ...get().settings, [key]: value } });
  },
}));
