import { useEffect, useRef } from "react";
import { Play, Pause, Check, X, ArrowRight, RotateCcw, Music2, Image, AudioWaveform, Volume2, VolumeX } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import {
  useGuessGameStore,
  type SnippetPosition,
  type GuessMode,
} from "../stores/guessGameStore";
import { usePlayerStore } from "../stores/playerStore";
import { audioPause, audioSetVolume } from "../lib/commands";
import { GuessWaveform } from "./GuessWaveform";

/** Volume slider for the game stage. The player bar (which normally pushes
 *  volume to the Rust engine) is unmounted on this tab, so we apply it directly
 *  here while keeping the shared, persisted player volume as the source. */
function VolumeControl() {
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const onChange = (v: number) => {
    setVolume(v);
    void audioSetVolume(v).catch(() => {});
  };
  return (
    <div className="flex items-center gap-1.5">
      {volume === 0 ? (
        <VolumeX size={14} className="text-neutral-400" />
      ) : (
        <Volume2 size={14} className="text-neutral-400" />
      )}
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1 w-24 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
        style={{ background: `linear-gradient(to right, #fff ${volume * 100}%, #333 ${volume * 100}%)` }}
      />
    </div>
  );
}

const POSITIONS: Array<{ id: SnippetPosition; label: string; hint: string }> = [
  { id: "first", label: "First Second", hint: "the intro — easiest" },
  { id: "drop", label: "The Drop", hint: "somewhere in the middle" },
  { id: "needle", label: "Blind Needle", hint: "anywhere at random" },
  { id: "outro", label: "Outro", hint: "the ending — brutal" },
];

const LENGTHS = [0.5, 1, 3, 10];
const MODES: Array<{ id: GuessMode; label: string; icon: typeof Music2 }> = [
  { id: "audio", label: "Audio", icon: Music2 },
  { id: "art", label: "Cover Art", icon: Image },
  { id: "waveform", label: "Waveform", icon: AudioWaveform },
];

function ConfigPanel() {
  const config = useGuessGameStore((s) => s.config);
  const setConfig = useGuessGameStore((s) => s.setConfig);
  const start = useGuessGameStore((s) => s.start);
  const error = useGuessGameStore((s) => s.error);

  const pill = (active: boolean) =>
    `rounded-lg border px-3 py-2 text-sm transition-colors ${
      active
        ? "border-violet-500 bg-violet-500/15 text-white"
        : "border-[#333] text-neutral-400 hover:border-[#555] hover:text-neutral-200"
    }`;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Guess the Track</h2>
        <p className="text-sm text-neutral-500">Hear a sliver, name the song.</p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-wide text-neutral-500">Mode</span>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setConfig({ mode: id })} className={pill(config.mode === id)}>
              <Icon size={16} className="mx-auto mb-1" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {config.mode === "audio" && (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-xs uppercase tracking-wide text-neutral-500">Where from</span>
            <div className="grid grid-cols-2 gap-2">
              {POSITIONS.map((p) => (
                <button key={p.id} onClick={() => setConfig({ position: p.id })} className={pill(config.position === p.id)}>
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-neutral-500">{p.hint}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs uppercase tracking-wide text-neutral-500">Snippet length</span>
            <div className="grid grid-cols-4 gap-2">
              {LENGTHS.map((l) => (
                <button key={l} onClick={() => setConfig({ lengthSecs: l })} className={pill(config.lengthSecs === l)}>
                  {l}s
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-wide text-neutral-500">Choices</span>
        <div className="grid grid-cols-3 gap-2">
          {[2, 3, 4].map((c) => (
            <button key={c} onClick={() => setConfig({ choiceCount: c })} className={pill(config.choiceCount === c)}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        onClick={start}
        className="rounded-lg bg-violet-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-violet-500"
      >
        Start playing
      </button>
    </div>
  );
}

function Scoreboard() {
  const score = useGuessGameStore((s) => s.score);
  const streak = useGuessGameStore((s) => s.streak);
  const roundsPlayed = useGuessGameStore((s) => s.roundsPlayed);
  const correctCount = useGuessGameStore((s) => s.correctCount);
  const endGame = useGuessGameStore((s) => s.endGame);

  return (
    <div className="flex items-center gap-4 text-sm">
      <span className="font-semibold text-white">{score} pts</span>
      {streak > 1 && <span className="text-violet-400">🔥 {streak} streak</span>}
      <span className="text-neutral-500">
        {correctCount}/{roundsPlayed} correct
      </span>
      <div className="ml-auto flex items-center gap-3">
        <VolumeControl />
        <button onClick={endGame} className="rounded px-2 py-1 text-neutral-500 hover:text-white">
          End game
        </button>
      </div>
    </div>
  );
}

function SummaryPanel() {
  const score = useGuessGameStore((s) => s.score);
  const bestStreak = useGuessGameStore((s) => s.bestStreak);
  const correctCount = useGuessGameStore((s) => s.correctCount);
  const roundHistory = useGuessGameStore((s) => s.roundHistory);
  const summaryPlayingIndex = useGuessGameStore((s) => s.summaryPlayingIndex);
  const toggleSummaryTrack = useGuessGameStore((s) => s.toggleSummaryTrack);
  const exit = useGuessGameStore((s) => s.exit);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-white">Game over</h2>
        <p className="mt-1 text-sm text-neutral-400">
          {score} pts · {correctCount}/{roundHistory.length} correct · best streak {bestStreak}
        </p>
      </div>

      <div className="flex justify-center">
        <VolumeControl />
      </div>

      <div className="flex flex-col gap-2">
        {roundHistory.map((r, i) => {
          const playing = summaryPlayingIndex === i;
          return (
            <div
              key={i}
              className={`flex items-center gap-3 rounded-lg border p-2.5 transition-colors ${
                playing ? "border-violet-500 bg-violet-500/10" : "border-[#222] bg-[#161616]"
              }`}
            >
              <button
                onClick={() => toggleSummaryTrack(i)}
                className="group relative h-11 w-11 shrink-0 overflow-hidden rounded bg-[#222]"
                title={playing ? "Pause" : "Play"}
              >
                {r.track.cover_art_base64 ? (
                  <img
                    src={`data:image/jpeg;base64,${r.track.cover_art_base64}`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-neutral-600">
                    <Music2 size={16} />
                  </div>
                )}
                {/* Play/pause overlay: always shown while playing, on hover otherwise */}
                <div
                  className={`absolute inset-0 flex items-center justify-center bg-black/50 text-white transition-opacity ${
                    playing ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                </div>
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{r.track.title}</div>
                {r.track.artist && (
                  <div className="truncate text-xs text-neutral-400">{r.track.artist}</div>
                )}
              </div>
              {r.correct ? (
                <Check size={18} className="shrink-0 text-green-400" />
              ) : (
                <X size={18} className="shrink-0 text-red-400" />
              )}
            </div>
          );
        })}
      </div>

      <button
        onClick={exit}
        className="mx-auto rounded-lg bg-violet-600 px-5 py-2.5 font-medium text-white transition-colors hover:bg-violet-500"
      >
        New game
      </button>
    </div>
  );
}

function QuestionPanel() {
  const round = useGuessGameStore((s) => s.round);
  const config = useGuessGameStore((s) => s.config);
  const phase = useGuessGameStore((s) => s.phase);
  const selectedId = useGuessGameStore((s) => s.selectedId);
  const snippetPlaying = useGuessGameStore((s) => s.snippetPlaying);
  const fullPlaying = useGuessGameStore((s) => s.fullPlaying);
  const playSnippet = useGuessGameStore((s) => s.playSnippet);
  const toggleFull = useGuessGameStore((s) => s.toggleFull);
  const guess = useGuessGameStore((s) => s.guess);
  const nextRound = useGuessGameStore((s) => s.nextRound);

  if (!round) return null;
  const revealed = phase === "result";
  const answerId = round.answer.path;

  const choiceClass = (id: string) => {
    if (!revealed)
      return "border-[#333] bg-[#161616] hover:border-[#555] hover:bg-[#1e1e1e]";
    if (id === answerId) return "border-green-500 bg-green-500/15";
    if (id === selectedId) return "border-red-500 bg-red-500/15";
    return "border-[#333] bg-[#161616] opacity-50";
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Scoreboard />

      {/* Prompt area varies by mode */}
      <div className="flex min-h-[8rem] items-center justify-center rounded-xl border border-[#222] bg-[#0d0d0d] p-6">
        {config.mode === "audio" && (
          <button
            onClick={playSnippet}
            className="flex h-20 w-20 items-center justify-center rounded-full bg-violet-600 text-white transition-colors hover:bg-violet-500"
          >
            {snippetPlaying ? <Pause size={32} /> : <Play size={32} className="ml-1" />}
          </button>
        )}
        {config.mode === "art" && round.answer.cover_art_base64 && (
          <img
            src={`data:image/jpeg;base64,${round.answer.cover_art_base64}`}
            alt="Guess this cover"
            className="h-40 w-40 rounded-lg object-cover"
          />
        )}
        {config.mode === "waveform" && <GuessWaveform path={round.answer.path} />}
      </div>

      {/* Choices */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {round.choices.map((t) => (
          <button
            key={t.path}
            disabled={revealed}
            onClick={() => guess(t.path)}
            className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${choiceClass(t.path)}`}
          >
            {config.mode !== "art" && (
              <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-[#222]">
                {t.cover_art_base64 ? (
                  <img src={`data:image/jpeg;base64,${t.cover_art_base64}`} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-neutral-600">
                    <Music2 size={16} />
                  </div>
                )}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">{t.title}</div>
              {t.artist && <div className="truncate text-xs text-neutral-400">{t.artist}</div>}
            </div>
            {revealed && t.path === answerId && <Check size={18} className="text-green-400" />}
            {revealed && t.path === selectedId && t.path !== answerId && <X size={18} className="text-red-400" />}
          </button>
        ))}
      </div>

      {revealed && (
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={toggleFull}
            className="flex items-center gap-2 rounded-lg border border-[#333] px-4 py-2 text-sm text-neutral-300 transition-colors hover:border-[#555] hover:text-white"
          >
            {fullPlaying ? <Pause size={16} /> : <Play size={16} />}
            {fullPlaying ? "Pause" : "Resume"}
          </button>
          <button
            onClick={nextRound}
            className="flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 font-medium text-white transition-colors hover:bg-violet-500"
          >
            Next round <ArrowRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export function GuessGameView() {
  const phase = useGuessGameStore((s) => s.phase);

  // Entering the game unmounts the player bar, but the Rust player keeps
  // playing whatever was going. Pause it (state + engine directly, since the
  // AudioPlayer sync effect is no longer mounted to do it for us) so background
  // music doesn't bleed over a "guess the track" round.
  useEffect(() => {
    if (usePlayerStore.getState().isPlaying) {
      usePlayerStore.getState().setPlaying(false);
      void audioPause().catch(() => {});
    }
  }, []);

  // The player bar normally owns the audio://ended listener, but it's unmounted
  // here — so mount our own. It auto-advances the summary playlist and resets
  // the reveal button when a full track finishes. Route through a ref so the
  // one-time listener always calls the latest store action.
  const endedRef = useRef(useGuessGameStore.getState().handleAudioEnded);
  useEffect(() => {
    endedRef.current = useGuessGameStore.getState().handleAudioEnded;
  });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("audio://ended", () => endedRef.current()).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-center p-6">
        {phase === "config" ? (
          <ConfigPanel />
        ) : phase === "summary" ? (
          <SummaryPanel />
        ) : (
          <QuestionPanel />
        )}
        {(phase === "question" || phase === "result") && (
          <div className="mt-8 flex justify-center">
            <ResetHint />
          </div>
        )}
      </div>
    </div>
  );
}

function ResetHint() {
  const exit = useGuessGameStore((s) => s.exit);
  return (
    <button onClick={exit} className="flex items-center gap-1.5 text-xs text-neutral-600 hover:text-neutral-400">
      <RotateCcw size={12} /> Change settings
    </button>
  );
}
