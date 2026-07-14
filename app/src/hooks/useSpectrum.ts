import { useEffect, useRef, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";

/** Number of log-spaced spectrum bands emitted by the Rust audio engine.
 * Must stay in sync with `SPECTRUM_BANDS` in `src-tauri/src/audio.rs`. */
export const SPECTRUM_BANDS = 48;

interface SpectrumPayload {
  bins: number[];
}

/**
 * Subscribe to the Rust engine's ~60Hz `audio://spectrum` stream and expose the
 * latest normalized (~0..1) log-bucketed FFT bands via a ref.
 *
 * A ref rather than state on purpose: consumers read it inside their own rAF
 * loop, so surfacing every event through React would trigger 60 re-renders/sec
 * for nothing. The ref is swapped in place; readers always see the newest bins.
 */
export function useSpectrum(): MutableRefObject<number[]> {
  const binsRef = useRef<number[]>(new Array(SPECTRUM_BANDS).fill(0));
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<SpectrumPayload>("audio://spectrum", (e) => {
      binsRef.current = e.payload.bins;
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);
  return binsRef;
}
