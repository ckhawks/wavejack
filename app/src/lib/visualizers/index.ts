import type { VisualizerEntry } from "./types";
import { createBars } from "./bars";
import { createRadial } from "./radial";
import { createAurora } from "./aurora";
import { createAcid } from "./acid";
import { createLasers } from "./lasers";

export type { Visualizer, VisualizerEntry, VizFrame, RGB } from "./types";

/** Id of the non-canvas ambient blob background, rendered directly by the
 * immersive player. Kept in the backdrop list so the picker can offer it
 * alongside the canvas visualizers. */
export const AMBIENT_ID = "ambient";

/** Canvas, spectrum-reactive visualizers. Add new ones here — each is a factory
 * returning fresh per-instance state, so registration is a single line. */
export const VISUALIZERS: VisualizerEntry[] = [
  { id: "aurora", name: "Aurora", create: createAurora },
  { id: "bars", name: "Bars", create: createBars },
  { id: "radial", name: "Radial", create: createRadial },
  { id: "acid", name: "Acid", create: createAcid },
  { id: "lasers", name: "Lasers", create: createLasers },
];

/** All selectable backdrops for the immersive view (ambient blobs + canvas). */
export const BACKDROP_OPTIONS: { id: string; name: string }[] = [
  { id: AMBIENT_ID, name: "Ambient" },
  ...VISUALIZERS.map((v) => ({ id: v.id, name: v.name })),
];

export function getVisualizer(id: string): VisualizerEntry | undefined {
  return VISUALIZERS.find((v) => v.id === id);
}
