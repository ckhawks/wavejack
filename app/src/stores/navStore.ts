import { create } from "zustand";

export type Tab = "home" | "downloads" | "library" | "discover" | "rooms" | "feed";

interface NavStore {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
}

export const useNavStore = create<NavStore>((set) => ({
  activeTab: "home",
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
