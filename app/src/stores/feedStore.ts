import { create } from "zustand";
import type { Subscription, FeedItem } from "../lib/types";
import {
  addSubscription,
  removeSubscription,
  listSubscriptions,
  refreshFeed,
  getFeed,
} from "../lib/commands";

interface FeedStore {
  subscriptions: Subscription[];
  items: FeedItem[];
  refreshing: boolean;
  adding: boolean;
  loaded: boolean;
  channelFilter: string | null;

  init: () => Promise<void>;
  addChannel: (url: string) => Promise<void>;
  removeChannel: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  reloadItems: () => Promise<void>;
  setChannelFilter: (id: string | null) => void;
  filteredItems: () => FeedItem[];
}

export const useFeedStore = create<FeedStore>((set, get) => ({
  subscriptions: [],
  items: [],
  refreshing: false,
  adding: false,
  loaded: false,
  channelFilter: null,

  init: async () => {
    if (get().loaded) return;
    try {
      const [subscriptions, items] = await Promise.all([
        listSubscriptions(),
        getFeed(),
      ]);
      set({ subscriptions, items, loaded: true });
    } catch (e) {
      console.error("Failed to init feed:", e);
      set({ loaded: true });
    }
  },

  addChannel: async (url) => {
    set({ adding: true });
    try {
      const sub = await addSubscription(url);
      set((s) => ({ subscriptions: [sub, ...s.subscriptions] }));
      // Items will appear after background fetch completes; reload after a delay
      setTimeout(() => get().reloadItems(), 3000);
    } catch (e) {
      console.error("Failed to add subscription:", e);
    } finally {
      set({ adding: false });
    }
  },

  removeChannel: async (id) => {
    try {
      await removeSubscription(id);
      set((s) => ({
        subscriptions: s.subscriptions.filter((sub) => sub.id !== id),
        items: s.items.filter((item) => item.channel_id !== id),
        channelFilter: s.channelFilter === id ? null : s.channelFilter,
      }));
    } catch (e) {
      console.error("Failed to remove subscription:", e);
    }
  },

  refresh: async () => {
    set({ refreshing: true });
    try {
      await refreshFeed();
    } catch (e) {
      console.error("Failed to refresh feed:", e);
      set({ refreshing: false });
    }
  },

  reloadItems: async () => {
    try {
      const items = await getFeed();
      set({ items });
    } catch (e) {
      console.error("Failed to reload feed items:", e);
    }
  },

  setChannelFilter: (id) => set({ channelFilter: id }),

  filteredItems: () => {
    const { items, channelFilter } = get();
    if (!channelFilter) return items;
    return items.filter((item) => item.channel_id === channelFilter);
  },
}));
