import { afterEach, describe, expect, it, vi } from "vitest";

// The store imports Tauri-backed commands and the download store at module load.
// Stub both so importing playerStore never reaches into the Tauri IPC layer.
// `vi.hoisted` lets the mock factory (hoisted above imports) share the spy handle.
const { audioSeek } = vi.hoisted(() => ({ audioSeek: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/commands", () => ({
  setSetting: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({})),
  audioSeek,
}));
vi.mock("./downloadStore", () => ({
  useDownloadStore: { getState: () => ({ downloads: [] }) },
}));

import { resolveAdjacent, usePlayerStore, type PlayerTrack } from "./playerStore";

const track = (id: string): PlayerTrack => ({ id, title: id, filePath: `/music/${id}.mp3` });

const a = track("a");
const b = track("b");
const c = track("c");

function resetStore(patch: Partial<ReturnType<typeof usePlayerStore.getState>>) {
  usePlayerStore.setState({
    currentTrack: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    queue: [],
    history: [],
    forward: [],
    shuffle: false,
    ...patch,
  });
}

afterEach(() => vi.clearAllMocks());

describe("resolveAdjacent (queue navigation)", () => {
  it("steps forward through the queue", () => {
    expect(resolveAdjacent(a, [a, b, c], false, 1)).toEqual(b);
  });

  it("steps backward through the queue", () => {
    expect(resolveAdjacent(b, [a, b, c], false, -1)).toEqual(a);
  });

  it("returns null at the forward edge", () => {
    expect(resolveAdjacent(c, [a, b, c], false, 1)).toBeNull();
  });

  it("returns null at the backward edge", () => {
    expect(resolveAdjacent(a, [a, b, c], false, -1)).toBeNull();
  });

  it("falls back to (empty) download adjacency when current is not in the queue", () => {
    expect(resolveAdjacent(track("z"), [a, b, c], false, 1)).toBeNull();
  });

  it("shuffle-forward picks a different in-queue track (never the current one)", () => {
    // 0.5 * 3 = 1.5 -> index 1; for current=a (index 0) that's a valid non-self pick.
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const next = resolveAdjacent(a, [a, b, c], true, 1);
    expect(next).not.toBeNull();
    expect(next?.id).not.toBe(a.id);
    expect([a, b, c]).toContainEqual(next);
    rand.mockRestore();
  });

  it("shuffle does not apply to backward navigation (stays deterministic)", () => {
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(resolveAdjacent(b, [a, b, c], true, -1)).toEqual(a);
    rand.mockRestore();
  });
});

describe("playPrev", () => {
  it("restarts the current track when past the 3s threshold", () => {
    resetStore({ currentTrack: a, currentTime: 5, queue: [a, b] });
    usePlayerStore.getState().playPrev();
    const s = usePlayerStore.getState();
    expect(s.currentTrack).toEqual(a); // same track
    expect(s.currentTime).toBe(0);
    expect(audioSeek).toHaveBeenCalledWith(0);
  });

  it("goes to the previous track when within the first 3s", () => {
    resetStore({ currentTrack: b, currentTime: 1, queue: [a, b] });
    usePlayerStore.getState().playPrev();
    expect(usePlayerStore.getState().currentTrack).toEqual(a);
    expect(audioSeek).not.toHaveBeenCalled();
  });
});

describe("history / forward retrace", () => {
  it("next then prev then next retraces the same path", () => {
    resetStore({ currentTrack: a, queue: [a, b] });

    usePlayerStore.getState().playNext(); // a -> b, history=[a]
    expect(usePlayerStore.getState().currentTrack).toEqual(b);
    expect(usePlayerStore.getState().history.map((t) => t.id)).toEqual(["a"]);

    usePlayerStore.getState().playPrev(); // b -> a via history, forward=[b]
    expect(usePlayerStore.getState().currentTrack).toEqual(a);
    expect(usePlayerStore.getState().forward.map((t) => t.id)).toEqual(["b"]);

    usePlayerStore.getState().playNext(); // retrace forward -> b
    expect(usePlayerStore.getState().currentTrack).toEqual(b);
    expect(usePlayerStore.getState().forward).toEqual([]);
  });

  it("stops playback at the end of the queue with no shuffle", () => {
    resetStore({ currentTrack: b, queue: [a, b], isPlaying: true });
    usePlayerStore.getState().playNext();
    const s = usePlayerStore.getState();
    expect(s.currentTrack).toEqual(b); // unchanged
    expect(s.isPlaying).toBe(false);
  });
});
