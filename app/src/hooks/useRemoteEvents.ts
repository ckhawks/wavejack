import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useDiscoverStore } from "../stores/discoverStore";
import { usePlayerStore } from "../stores/playerStore";

interface RemoteAction {
  action: string;
  delta?: number;
}

// Perceptual volume ladder: closely spaced near silence, wider toward the top,
// since perceived loudness is roughly logarithmic. Remote up/down moves one
// stop. Note the small first step out of mute (0 → 0.01 → 0.03) for fine
// control at the quiet end.
export const VOLUME_STOPS = [
  0, 0.01, 0.03, 0.06, 0.1, 0.15, 0.22, 0.3, 0.4, 0.52, 0.66, 0.82, 1,
];

/** Next volume for a remote up/down press, one stop along VOLUME_STOPS. */
export function nextVolume(current: number, direction: "up" | "down"): number {
  // eps tolerates float drift and slider positions that land between stops.
  const eps = 1e-4;
  if (direction === "up") {
    return VOLUME_STOPS.find((s) => s > current + eps) ?? 1;
  }
  for (let i = VOLUME_STOPS.length - 1; i >= 0; i--) {
    if (VOLUME_STOPS[i] < current - eps) return VOLUME_STOPS[i];
  }
  return 0;
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
        player.setVolume(nextVolume(player.volume, "up"));
      } else if (e.payload.action === "volume-down") {
        player.setVolume(nextVolume(player.volume, "down"));
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
