import { describe, expect, it, vi } from "vitest";

// The store pulls in Tauri-backed commands + the library store at module load.
// Stub both so importing it never reaches the IPC layer (the pure helpers under
// test don't touch either, but the imports run regardless).
vi.mock("../lib/commands", () => ({
  audioLoad: vi.fn(() => Promise.resolve({ duration: 0 })),
  audioSeek: vi.fn(() => Promise.resolve()),
  audioPlay: vi.fn(() => Promise.resolve()),
  audioPause: vi.fn(() => Promise.resolve()),
  audioStop: vi.fn(() => Promise.resolve()),
}));
vi.mock("./libraryStore", () => ({
  useLibraryStore: { getState: () => ({ tracks: [] }) },
}));

import { computeOffset, pickChoices, scoreGuess } from "./guessGameStore";
import type { LibraryTrack } from "../lib/commands";

/** Deterministic RNG that walks a fixed sequence, clamped to [0,1). */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("computeOffset", () => {
  it("first is always the start", () => {
    expect(computeOffset(200, "first", 3, seq([0.5]))).toBe(0);
  });

  it("outro lands at the last playable window", () => {
    expect(computeOffset(200, "outro", 10, seq([0.9]))).toBe(190);
  });

  it("drop stays inside the middle 70% and leaves room for the snippet", () => {
    // With rand=0 it sits at the low edge (15%); rand=1 at the high edge.
    expect(computeOffset(200, "drop", 10, seq([0]))).toBeCloseTo(30); // 200*0.15
    expect(computeOffset(200, "drop", 10, seq([1]))).toBeCloseTo(160); // 200*0.85 - 10
  });

  it("needle spans the whole playable window", () => {
    expect(computeOffset(200, "needle", 10, seq([0]))).toBe(0);
    expect(computeOffset(200, "needle", 10, seq([1]))).toBe(190);
  });

  it("clamps a track shorter than the snippet to offset 0", () => {
    expect(computeOffset(2, "needle", 10, seq([0.7]))).toBe(0);
    expect(computeOffset(2, "drop", 10, seq([0.7]))).toBe(0);
    expect(computeOffset(2, "outro", 10, seq([0.7]))).toBe(0);
  });
});

const track = (id: string): LibraryTrack => ({
  path: id,
  filename: id,
  title: id,
  artist: "",
  album: "",
  duration_secs: 200,
  cover_art_base64: "",
  first_scanned_at: 0,
  bitrate_kbps: 0,
  bitrate_estimated: false,
  play_count: 0,
  last_played_at: 0,
  tags: [],
  file_type: "MP3",
});

describe("pickChoices", () => {
  it("returns exactly `count` distinct choices including the answer", () => {
    const pool = ["a", "b", "c", "d", "e"].map(track);
    const { answer, choices } = pickChoices(pool, 4, seq([0.1, 0.2, 0.3, 0.4, 0.5]));
    expect(choices).toHaveLength(4);
    expect(new Set(choices.map((c) => c.path)).size).toBe(4);
    expect(choices).toContainEqual(answer);
  });

  it("draws only from the given pool", () => {
    const pool = ["a", "b"].map(track);
    const { choices } = pickChoices(pool, 2, seq([0.5]));
    for (const c of choices) expect(["a", "b"]).toContain(c.path);
  });
});

describe("scoreGuess", () => {
  it("scores nothing for a wrong guess", () => {
    expect(scoreGuess(false, 1, 5)).toBe(0);
  });

  it("pays more for shorter snippets", () => {
    expect(scoreGuess(true, 1, 0)).toBeGreaterThan(scoreGuess(true, 10, 0));
  });

  it("applies a streak multiplier", () => {
    const base = scoreGuess(true, 3, 0);
    expect(scoreGuess(true, 3, 5)).toBe(Math.round(base * 1.5));
  });
});
