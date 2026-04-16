import { create } from "zustand";

export type Tab = "downloads" | "library" | "discover" | "rooms" | "feed";

interface NavStore {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
}

export const useNavStore = create<NavStore>((set) => ({
  activeTab: "downloads",
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
