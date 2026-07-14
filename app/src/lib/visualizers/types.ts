export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Everything a visualizer needs to draw a single frame. */
export interface VizFrame {
  ctx: CanvasRenderingContext2D;
  /** Logical (CSS px) canvas width. The context is already DPR-scaled, so draw
   * in these coordinates and ignore the backing-store size. */
  width: number;
  height: number;
  /** Smoothed spectrum, length `SPECTRUM_BANDS`, values ~0..1. Low index = low
   * frequency. Smoothing (fast attack, slow release) is applied upstream. */
  bins: Float32Array;
  /** Overall smoothed loudness, ~0..1 — handy for bass-driven pulsing. */
  level: number;
  /** Dominant cover colors, brightest first; always has at least one entry. */
  palette: RGB[];
  /** Seconds since this visualizer instance started. */
  time: number;
  /** Seconds since the previous frame, clamped to avoid tab-switch jumps. */
  dt: number;
  isPlaying: boolean;
}

export interface Visualizer {
  /** Called once on mount and again on every resize. Use to (re)allocate
   * size-dependent state such as particle fields. */
  init?(width: number, height: number): void;
  /** Draw one frame. The canvas is NOT auto-cleared between frames — clear or
   * fade it yourself (fading gives motion trails). */
  draw(frame: VizFrame): void;
}

export interface VisualizerEntry {
  id: string;
  name: string;
  /** Factory so each mount gets its own fresh per-instance state. */
  create: () => Visualizer;
}
