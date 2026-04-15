import { useEffect, useRef, useState } from "react";
import { Music, SkipForward, Volume2, ThumbsUp, ThumbsDown, Heart } from "lucide-react";
import { useRoomStore } from "../../stores/roomStore";

export function NowPlaying() {
  const { currentTrack, playbackStartedAt, serverUrl, currentDj, userId, users, skipTrack, react, grabTrack, reactions } = useRoomStore();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(0.8);

  const canSkip = currentDj === userId;
  const djName = users.find((u) => u.id === currentDj)?.name ?? "Unknown";

  const myReaction = userId
    ? reactions.woots.includes(userId) ? "woot"
    : reactions.mehs.includes(userId) ? "meh"
    : reactions.grabs.includes(userId) ? "grab"
    : null
    : null;

  useEffect(() => {
    if (!currentTrack || !audioRef.current) return;

    const audio = audioRef.current;
    const url = `${serverUrl}${currentTrack.url}`;
    audio.src = url;
    audio.volume = volume;

    if (playbackStartedAt) {
      const elapsed = (Date.now() - playbackStartedAt) / 1000;
      audio.currentTime = Math.max(0, elapsed);
    }

    audio.play().catch(() => {});
  }, [currentTrack, serverUrl, playbackStartedAt]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!currentTrack || !playbackStartedAt) {
      setProgress(0);
      return;
    }
    const interval = setInterval(() => {
      const elapsed = (Date.now() - playbackStartedAt) / 1000;
      const pct = currentTrack.duration > 0 ? Math.min(elapsed / currentTrack.duration, 1) : 0;
      setProgress(pct);
    }, 500);
    return () => clearInterval(interval);
  }, [currentTrack, playbackStartedAt]);

  if (!currentTrack) {
    return (
      <div className="flex items-center gap-3 rounded border border-[#222] bg-[#0a0a0a] p-3">
        <Music size={16} className="text-neutral-600" />
        <p className="text-xs text-neutral-500">Nothing playing</p>
      </div>
    );
  }

  const elapsed = playbackStartedAt ? Math.floor((Date.now() - playbackStartedAt) / 1000) : 0;
  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const coverUrl = currentTrack.coverArtUrl ? `${serverUrl}${currentTrack.coverArtUrl}` : null;

  return (
    <div className="flex flex-col gap-2 rounded border border-[#222] bg-[#0a0a0a] p-3">
      <audio ref={audioRef} />

      {/* Cover art */}
      {coverUrl && (
        <img src={coverUrl} alt="" className="w-full rounded object-cover" />
      )}

      {/* Track info */}
      <div>
        <p className="truncate text-sm font-medium text-white">{currentTrack.title}</p>
        <p className="truncate text-xs text-neutral-400">
          {currentTrack.artist}{currentTrack.album ? ` — ${currentTrack.album}` : ""}
        </p>
        <p className="text-[10px] text-neutral-600">DJ: {djName}</p>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-neutral-500">{formatTime(elapsed)}</span>
        <div className="flex-1 overflow-hidden rounded-full bg-[#222]" style={{ height: 3 }}>
          <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
        <span className="text-[10px] text-neutral-500">
          {currentTrack.duration > 0 ? formatTime(currentTrack.duration) : "--:--"}
        </span>
      </div>

      {/* Volume + skip */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Volume2 size={12} className="text-neutral-500" />
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="h-1 w-16 accent-violet-500"
          />
        </div>
        {canSkip && (
          <button onClick={skipTrack} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-[#222] hover:text-white">
            <SkipForward size={12} />
            Skip
          </button>
        )}
      </div>

      {/* Reactions */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => react("woot")}
          className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
            myReaction === "woot" ? "bg-green-600/30 text-green-400" : "bg-[#1a1a1a] text-neutral-400 hover:text-green-400"
          }`}
        >
          <ThumbsUp size={11} />
          <span>{reactions.woots.length}</span>
        </button>
        <button
          onClick={() => grabTrack()}
          className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
            myReaction === "grab" ? "bg-violet-600/30 text-violet-400" : "bg-[#1a1a1a] text-neutral-400 hover:text-violet-400"
          }`}
        >
          <Heart size={11} />
          <span>{reactions.grabs.length}</span>
        </button>
        <button
          onClick={() => react("meh")}
          className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
            myReaction === "meh" ? "bg-red-600/30 text-red-400" : "bg-[#1a1a1a] text-neutral-400 hover:text-red-400"
          }`}
        >
          <ThumbsDown size={11} />
          <span>{reactions.mehs.length}</span>
        </button>
      </div>
    </div>
  );
}
