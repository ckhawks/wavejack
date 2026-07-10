import { create } from "zustand";

export type Tab = "home" | "downloads" | "library" | "recent" | "discover" | "rooms" | "feed" | "extras";

interface NavStore {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
}

export const useNavStore = create<NavStore>((set) => ({
  activeTab: "home",
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
