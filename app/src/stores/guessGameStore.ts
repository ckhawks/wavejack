import { create } from "zustand";
import { type LibraryTrack, audioLoad, audioSeek, audioPlay, audioPause, audioStop } from "../lib/commands";
import { useLibraryStore } from "./libraryStore";

/** Which slice of the track the snippet is drawn from. */
export type SnippetPosition = "first" | "drop" | "needle" | "outro";

/** How the answer is presented. `audio` plays a snippet; `art`/`waveform` are
 *  silent visual rounds that lean on the library's cover art / cached waveform. */
export type GuessMode = "audio" | "art" | "waveform";

export interface GuessConfig {
  position: SnippetPosition;
  /** Snippet length in seconds (audio mode) — also the scoring difficulty knob. */
  lengthSecs: number;
  mode: GuessMode;
  /** Number of choices shown, including the answer. 2..4. */
  choiceCount: number;
}

export interface GuessRound {
  answer: LibraryTrack;
  /** All choices including the answer, in display order. */
  choices: LibraryTrack[];
  /** Where the snippet starts, in seconds (audio mode only). */
  offsetSecs: number;
}

/** One completed round, kept for the end-game summary. */
export interface RoundResult {
  track: LibraryTrack;
  correct: boolean;
}

type Phase = "config" | "question" | "result" | "summary";

interface GuessGameState {
  config: GuessConfig;
  phase: Phase;
  round: GuessRound | null;
  selectedId: string | null;
  snippetPlaying: boolean;
  /** True while the full answer track is streaming on the result screen. */
  fullPlaying: boolean;
  /** True once the full track has been loaded this round, so a pause→resume
   *  continues from position instead of restarting. */
  fullLoaded: boolean;
  score: number;
  streak: number;
  bestStreak: number;
  roundsPlayed: number;
  correctCount: number;
  /** Every answered round, in play order — drives the end-game summary. */
  roundHistory: RoundResult[];
  /** Index into roundHistory of the track previewing on the summary screen. */
  summaryPlayingIndex: number | null;
  /** Set when the library doesn't have enough usable tracks to build a round. */
  error: string | null;

  setConfig: (patch: Partial<GuessConfig>) => void;
  start: () => void;
  playSnippet: () => Promise<void>;
  stopSnippet: () => Promise<void>;
  toggleFull: () => Promise<void>;
  guess: (id: string) => void;
  nextRound: () => void;
  endGame: () => void;
  playSummaryIndex: (index: number) => Promise<void>;
  toggleSummaryTrack: (index: number) => Promise<void>;
  /** Handle an audio://ended event: reset the summary/reveal play button when a
   *  track finishes (no auto-advance — recap playback is opt-in). */
  handleAudioEnded: () => void;
  exit: () => void;
}

const DEFAULT_CONFIG: GuessConfig = {
  position: "drop",
  lengthSecs: 3,
  mode: "audio",
  choiceCount: 4,
};

// Snippet auto-stop timer. Module-level (not reactive state) so re-renders never
// touch it; cleared on every stop/next/exit so a stale timer can't pause a later
// snippet.
let snippetTimer: ReturnType<typeof setTimeout> | null = null;
function clearSnippetTimer(): void {
  if (snippetTimer !== null) {
    clearTimeout(snippetTimer);
    snippetTimer = null;
  }
}

/** Compute the snippet start offset for a track. Guards short tracks by clamping
 *  into the valid `[0, duration - length]` window. `rand` is injectable for
 *  deterministic tests. Exported as a test seam. */
export function computeOffset(
  durationSecs: number,
  position: SnippetPosition,
  lengthSecs: number,
  rand: () => number = Math.random,
): number {
  const maxStart = Math.max(0, durationSecs - lengthSecs);
  switch (position) {
    case "first":
      return 0;
    case "outro":
      return maxStart;
    case "drop": {
      // Random within the middle 70%, so we never land on the intro or outro.
      const lo = Math.min(durationSecs * 0.15, maxStart);
      const hi = Math.min(durationSecs * 0.85 - lengthSecs, maxStart);
      if (hi <= lo) return lo;
      return lo + rand() * (hi - lo);
    }
    case "needle":
      return rand() * maxStart;
  }
}

/** Pick `count` distinct tracks and designate one as the answer, returning the
 *  choices in a shuffled order. Assumes `pool.length >= count`. Exported as a
 *  test seam. */
export function pickChoices(
  pool: LibraryTrack[],
  count: number,
  rand: () => number = Math.random,
): { answer: LibraryTrack; choices: LibraryTrack[] } {
  // Fisher–Yates on a copy, take the first `count`.
  const copy = pool.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  const choices = copy.slice(0, count);
  const answer = choices[Math.floor(rand() * choices.length)];
  return { answer, choices };
}

/** Points for one guess. Shorter snippets and hot streaks pay more; a wrong
 *  guess is worth nothing. Exported as a test seam. */
export function scoreGuess(correct: boolean, lengthSecs: number, streak: number): number {
  if (!correct) return 0;
  // Base 100, scaled up for shorter snippets (a 1s guess is worth ~3x a 10s one),
  // then a +10% per prior-streak multiplier.
  const lengthBonus = Math.round(100 * (3 / Math.max(1, lengthSecs)));
  const streakMult = 1 + streak * 0.1;
  return Math.round(lengthBonus * streakMult);
}

/** Tracks usable for a given mode: `art` needs cover art, everything needs a
 *  known positive duration so we can seek/snippet. */
function usablePool(mode: GuessMode): LibraryTrack[] {
  const tracks = useLibraryStore.getState().tracks;
  return tracks.filter((t) => {
    if (t.duration_secs <= 0) return false;
    if (mode === "art" && !t.cover_art_base64) return false;
    return true;
  });
}

function buildRound(config: GuessConfig): GuessRound | null {
  const pool = usablePool(config.mode);
  if (pool.length < config.choiceCount) return null;
  const { answer, choices } = pickChoices(pool, config.choiceCount);
  const offsetSecs = computeOffset(answer.duration_secs, config.position, config.lengthSecs);
  return { answer, choices, offsetSecs };
}

export const useGuessGameStore = create<GuessGameState>((set, get) => ({
  config: DEFAULT_CONFIG,
  phase: "config",
  round: null,
  selectedId: null,
  snippetPlaying: false,
  fullPlaying: false,
  fullLoaded: false,
  score: 0,
  streak: 0,
  bestStreak: 0,
  roundsPlayed: 0,
  correctCount: 0,
  roundHistory: [],
  summaryPlayingIndex: null,
  error: null,

  setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),

  start: () => {
    const { config } = get();
    const round = buildRound(config);
    if (!round) {
      const need = config.choiceCount;
      set({
        error:
          config.mode === "art"
            ? `Need at least ${need} library tracks with cover art for this mode.`
            : `Need at least ${need} library tracks to play.`,
      });
      return;
    }
    set({
      phase: "question",
      round,
      selectedId: null,
      score: 0,
      streak: 0,
      bestStreak: 0,
      roundsPlayed: 0,
      correctCount: 0,
      roundHistory: [],
      summaryPlayingIndex: null,
      error: null,
    });
  },

  playSnippet: async () => {
    const { round, config, snippetPlaying } = get();
    if (!round || config.mode !== "audio") return;
    if (snippetPlaying) {
      await get().stopSnippet();
      return;
    }
    clearSnippetTimer();
    try {
      await audioLoad(round.answer.path);
      await audioSeek(round.offsetSecs);
      await audioPlay();
    } catch (e) {
      console.error("guess snippet playback failed:", e);
      return;
    }
    set({ snippetPlaying: true });
    snippetTimer = setTimeout(() => {
      snippetTimer = null;
      void audioPause();
      set({ snippetPlaying: false });
    }, config.lengthSecs * 1000);
  },

  stopSnippet: async () => {
    clearSnippetTimer();
    if (get().snippetPlaying) {
      await audioPause().catch(() => {});
      set({ snippetPlaying: false });
    }
  },

  toggleFull: async () => {
    const { round, fullPlaying, fullLoaded } = get();
    if (!round) return;
    if (fullPlaying) {
      await audioPause().catch(() => {});
      set({ fullPlaying: false });
      return;
    }
    clearSnippetTimer();
    try {
      // Load once per round, starting the reveal at the snippet's own start
      // point (so you hear where the clip came from, then the rest of the song).
      // A later pause→resume just plays from the current position.
      if (!fullLoaded) {
        await audioLoad(round.answer.path);
        await audioSeek(round.offsetSecs);
      }
      await audioPlay();
    } catch (e) {
      console.error("full-track playback failed:", e);
      return;
    }
    set({ fullPlaying: true, fullLoaded: true, snippetPlaying: false });
  },

  guess: (id) => {
    const { round, config, phase, score, streak, bestStreak, roundsPlayed, correctCount, roundHistory } = get();
    if (!round || phase !== "question") return;
    // Stop the snippet timer synchronously so it can't fire mid-reveal; the
    // toggleFull below reloads the track and takes over playback.
    clearSnippetTimer();
    const correct = id === round.answer.path;
    const gained = scoreGuess(correct, config.lengthSecs, streak);
    const nextStreak = correct ? streak + 1 : 0;
    set({
      phase: "result",
      selectedId: id,
      snippetPlaying: false,
      score: score + gained,
      streak: nextStreak,
      bestStreak: Math.max(bestStreak, nextStreak),
      roundsPlayed: roundsPlayed + 1,
      correctCount: correctCount + (correct ? 1 : 0),
      roundHistory: [...roundHistory, { track: round.answer, correct }],
    });
    // Auto-reveal: play the full song starting from the snippet point.
    void get().toggleFull();
  },

  nextRound: () => {
    const { config, fullPlaying } = get();
    const round = buildRound(config);
    if (!round) return;
    // Stop any lingering full-track reveal before the next question.
    clearSnippetTimer();
    if (fullPlaying) void audioPause().catch(() => {});
    set({ phase: "question", round, selectedId: null, fullPlaying: false, fullLoaded: false });
  },

  endGame: () => {
    const { roundHistory } = get();
    clearSnippetTimer();
    // Nothing answered yet → just bail to config, no empty summary.
    if (roundHistory.length === 0) {
      get().exit();
      return;
    }
    // Land on the recap silent — playback is opt-in via the per-track buttons.
    void audioStop().catch(() => {});
    set({ phase: "summary", fullPlaying: false, snippetPlaying: false, summaryPlayingIndex: null });
  },

  playSummaryIndex: async (index) => {
    const { roundHistory } = get();
    const entry = roundHistory[index];
    if (!entry) return;
    clearSnippetTimer();
    try {
      await audioLoad(entry.track.path);
      await audioSeek(0);
      await audioPlay();
    } catch (e) {
      console.error("summary preview failed:", e);
      set({ summaryPlayingIndex: null });
      return;
    }
    set({ summaryPlayingIndex: index });
  },

  toggleSummaryTrack: async (index) => {
    if (get().summaryPlayingIndex === index) {
      await audioPause().catch(() => {});
      set({ summaryPlayingIndex: null });
      return;
    }
    await get().playSummaryIndex(index);
  },

  handleAudioEnded: () => {
    const { phase, fullPlaying } = get();
    if (phase === "summary") {
      // A recap track finished — reset its button; no auto-advance.
      set({ summaryPlayingIndex: null });
    } else if (fullPlaying) {
      // The full-song reveal finished; reset the pause/resume button.
      set({ fullPlaying: false });
    }
  },

  exit: () => {
    clearSnippetTimer();
    void audioStop().catch(() => {});
    set({
      phase: "config",
      round: null,
      selectedId: null,
      snippetPlaying: false,
      fullPlaying: false,
      fullLoaded: false,
      summaryPlayingIndex: null,
      error: null,
    });
  },
}));
