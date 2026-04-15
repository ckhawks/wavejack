import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useDiscoverStore } from "../stores/discoverStore";
import { usePlayerStore } from "../stores/playerStore";

interface RemoteAction {
  action: string;
  delta?: number;
}

const VOLUME_STEP = 0.1;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Subscribes to remote-control events emitted by the Tauri-side HTTP
 * server (see src-tauri/src/remote.rs). Used by external controllers
 * such as Stream Deck.
 */
export function useRemoteEvents() {
  useEffect(() => {
    const unlistenDiscover = listen<RemoteAction>("discover:remote", (e) => {
      const discover = useDiscoverStore.getState();
      if (e.payload.action === "approve") {
        discover.approveCurrent();
      } else if (e.payload.action === "skip" || e.payload.action === "reject") {
        discover.skipCurrent();
      }
    });

    const unlistenPlayer = listen<RemoteAction>("player:remote", (e) => {
      const player = usePlayerStore.getState();
      if (e.payload.action === "volume-up") {
        player.setVolume(clamp(player.volume + VOLUME_STEP, 0, 1));
      } else if (e.payload.action === "volume-down") {
        player.setVolume(clamp(player.volume - VOLUME_STEP, 0, 1));
      } else if (e.payload.action === "toggle") {
        player.togglePlayPause();
      }
    });

    return () => {
      unlistenDiscover.then((fn) => fn());
      unlistenPlayer.then((fn) => fn());
    };
  }, []);
}
