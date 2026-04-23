import { useState, useRef, useEffect } from "react";
import {
  X,
  CheckCircle,
  AlertCircle,
  Loader,
  Play,
  FolderOpen,
  Pencil,
  Save,
  Wand2,
  ExternalLink,
  ListMusic,
} from "lucide-react";
import { useDownloadStore } from "../stores/downloadStore";
import { usePlayerStore } from "../stores/playerStore";
import { openFile, revealFile, updateMp3Metadata, applyMetadata } from "../lib/commands";
import { MetadataPicker } from "./MetadataPicker";
import type { DownloadItem as DLItem } from "../lib/types";

interface Props {
  item: DLItem;
}

/** Color map for status indicators */
const statusColors: Record<string, string> = {
  pending: "text-neutral-500",
  downloading: "text-blue-400",
  converting: "text-yellow-400",
  complete: "text-green-400",
  error: "text-red-400",
  file_missing: "text-orange-400",
};

/** Icon for each status */
function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "complete":
      return <CheckCircle size={16} className="text-green-400" />;
    case "error":
      return <AlertCircle size={16} className="text-red-400" />;
    case "file_missing":
      return <AlertCircle size={16} className="text-orange-400" />;
    case "downloading":
    case "converting":
      return <Loader size={16} className="animate-spin text-blue-400" />;
    default:
      return <Loader size={16} className="text-neutral-500" />;
  }
}

/** Extract just the filename from a full path */
function getFilename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export function DownloadItem({ item }: Props) {
  const removeDownload = useDownloadStore((s) => s.removeDownload);
  const updateDownload = useDownloadStore((s) => s.updateDownload);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const isComplete = item.status === "complete" && item.filePath;
  const isFileMissing = item.status === "file_missing";
  const isMp3Complete = isComplete && item.format === "mp3";
  // Formats HTML5 audio can play inline (everything but video containers).
  // Prefer the post-download ground truth; fall back to the intent field.
  const audioFmt = (item.audioFormat || item.format || "").toLowerCase();
  const PLAYABLE_AUDIO = ["mp3", "flac", "m4a", "mp4a", "aac", "wav", "ogg", "opus"];
  const isAudioPlayable = isComplete && PLAYABLE_AUDIO.includes(audioFmt);

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editArtist, setEditArtist] = useState("");
  const [editFilename, setEditFilename] = useState("");
  const [saving, setSaving] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const filenameManuallyEdited = useRef(false);

  /** Parse "Artist - Title.mp3" from the filename, handling compound artists. */
  function parseFromFilename() {
    const name = editFilename.replace(/\.[^.]+$/, ""); // strip extension
    const dashIdx = name.indexOf(" - ");
    if (dashIdx >= 0) {
      setEditArtist(name.substring(0, dashIdx).trim());
      setEditTitle(name.substring(dashIdx + 3).trim());
    } else {
      // No dash separator — put it all in title
      setEditTitle(name.trim());
    }
    filenameManuallyEdited.current = false;
  }

  function startEditing() {
    setEditTitle(item.title || "");
    setEditArtist(item.artist || "");
    setEditFilename(item.filePath ? getFilename(item.filePath) : "");
    filenameManuallyEdited.current = false;
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
  }

  useEffect(() => {
    if (!editing || filenameManuallyEdited.current) return;
    if (editArtist && editTitle) {
      setEditFilename(`${editArtist} - ${editTitle}.mp3`);
    }
  }, [editing, editArtist, editTitle]);

  async function handleSave() {
    if (!item.filePath) return;
    setSaving(true);
    try {
      const newPath = await updateMp3Metadata(
        item.id,
        item.filePath,
        editTitle,
        editArtist,
        editFilename
      );
      updateDownload(item.id, {
        title: editTitle || item.title,
        artist: editArtist || undefined,
        filePath: newPath,
      });
      setEditing(false);
    } catch (e) {
      console.error("Failed to update metadata:", e);
    } finally {
      setSaving(false);
    }
  }

  function handlePlay() {
    if (!item.filePath) return;
    const track = {
      id: item.id,
      title: item.title || "Unknown",
      artist: item.artist,
      filePath: item.filePath,
      coverArtBase64: item.coverArtBase64,
    };
    const current = usePlayerStore.getState().currentTrack;
    if (current && current.id === item.id) {
      // Same track — update metadata without resetting playback
      usePlayerStore.setState({ currentTrack: track, isPlaying: true });
    } else {
      playTrack(track);
    }
  }

  return (
    <div className="group rounded-lg border border-[#222] bg-[#111] p-4 transition-all duration-200 hover:border-[#333]">
      <div className="flex items-start justify-between gap-3">
        {/* Left side: status icon + album art + info */}
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5">
            <StatusIcon status={item.status} />
          </div>

          {/* Small album art thumbnail */}
          {item.coverArtBase64 && (
            <img
              src={`data:image/jpeg;base64,${item.coverArtBase64}`}
              alt=""
              className="mt-0.5 h-6 w-6 shrink-0 rounded object-cover"
            />
          )}

          <div className="min-w-0 flex-1">
            {/* Title or URL */}
            <p className="truncate text-sm font-medium text-white">
              {item.title || item.url}
            </p>
            {/* Artist if set */}
            {item.artist && (
              <p className="truncate text-xs text-neutral-400">
                {item.artist}{item.album ? ` · ${item.album}` : ""}
              </p>
            )}
            {/* Status message */}
            <p
              className={`mt-1 text-xs ${statusColors[item.status] || "text-neutral-500"}`}
            >
              {isFileMissing ? "File moved or missing" : item.message}
            </p>
          </div>
        </div>

        {/* Right side: badges + actions */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Playlist badge */}
          {item.playlistTitle && (
            <span className="flex items-center gap-1 rounded bg-[#1a1a2e] px-2 py-0.5 text-xs font-medium text-indigo-400">
              <ListMusic size={10} />
              {item.playlistTitle}
            </span>
          )}
          {/* Format badge — prefer the post-download ground truth when
              available so "FLAC" doesn't lie about a track Tidal served as AAC. */}
          <span className="rounded bg-[#222] px-2 py-0.5 text-xs font-medium text-neutral-400">
            {(item.audioFormat || item.format).toUpperCase()}
            {item.bitrateKbps ? ` · ${item.bitrateKbps}k` : ""}
          </span>
          {/* Backend badge */}
          {item.backend && item.backend !== "none" && (
            <span className="rounded bg-[#222] px-2 py-0.5 text-xs font-medium text-neutral-500">
              {item.backend}
            </span>
          )}

          {/* Actions for completed downloads */}
          {isComplete && !isFileMissing && (
            <>
              {/* Audio (mp3/flac/m4a/...): Play in-app; video: Open externally */}
              {isAudioPlayable ? (
                <>
                  <button
                    onClick={handlePlay}
                    className="flex items-center gap-1 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-black transition-all duration-200 hover:bg-neutral-200"
                    title="Play in app"
                  >
                    <Play size={12} />
                    Play
                  </button>
                  <button
                    onClick={() => openFile(item.filePath!)}
                    className="rounded-md p-1 text-neutral-400 transition-all duration-200 hover:bg-[#222] hover:text-white"
                    title="Open in system player"
                  >
                    <ExternalLink size={14} />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => openFile(item.filePath!)}
                  className="flex items-center gap-1 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-black transition-all duration-200 hover:bg-neutral-200"
                  title="Open file"
                >
                  <Play size={12} />
                  Open
                </button>
              )}

              {/* Auto-tag button for MP3s */}
              {isMp3Complete && (
                <button
                  onClick={() => setShowMetadata(!showMetadata)}
                  className={`rounded-md p-1 transition-all duration-200 hover:bg-[#222] hover:text-white ${
                    showMetadata ? "text-blue-400" : "text-neutral-400"
                  }`}
                  title="Auto-tag with MusicBrainz"
                >
                  <Wand2 size={14} />
                </button>
              )}
              {/* Edit button for MP3s */}
              {isMp3Complete && (
                <button
                  onClick={startEditing}
                  className="rounded-md p-1 text-neutral-400 transition-all duration-200 hover:bg-[#222] hover:text-white"
                  title="Edit metadata"
                >
                  <Pencil size={14} />
                </button>
              )}
              <button
                onClick={() => revealFile(item.filePath!)}
                className="rounded-md p-1 text-neutral-400 transition-all duration-200 hover:bg-[#222] hover:text-white"
                title="Show in folder"
              >
                <FolderOpen size={14} />
              </button>
            </>
          )}

          {/* Remove button */}
          <button
            onClick={() => removeDownload(item.id)}
            className="rounded p-1 text-neutral-600 opacity-0 transition-all duration-200 hover:bg-[#222] hover:text-white group-hover:opacity-100"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {(item.status === "downloading" || item.status === "converting") && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#222]">
          <div
            className="h-full rounded-full bg-white transition-all duration-300"
            style={{ width: `${Math.min(item.progress, 100)}%` }}
          />
        </div>
      )}

      {/* Inline edit form for MP3 metadata */}
      {editing && (
        <div className="mt-3 space-y-2 border-t border-[#222] pt-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Title"
              className="flex-1 rounded border border-[#333] bg-[#111] px-2 py-1 text-sm text-white placeholder-neutral-600 outline-none focus:border-neutral-500"
            />
            <input
              type="text"
              value={editArtist}
              onChange={(e) => setEditArtist(e.target.value)}
              placeholder="Artist"
              className="flex-1 rounded border border-[#333] bg-[#111] px-2 py-1 text-sm text-white placeholder-neutral-600 outline-none focus:border-neutral-500"
            />
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={editFilename}
              onChange={(e) => {
                filenameManuallyEdited.current = true;
                setEditFilename(e.target.value);
              }}
              placeholder="Filename"
              className="flex-1 rounded border border-[#333] bg-[#111] px-2 py-1 text-sm text-white placeholder-neutral-600 outline-none focus:border-neutral-500"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={parseFromFilename}
              className="flex items-center gap-1 rounded-md border border-[#333] px-3 py-1 text-xs font-medium text-neutral-400 transition-all duration-200 hover:border-[#555] hover:text-white"
              title="Parse artist & title from filename"
            >
              <Wand2 size={12} />
              Parse
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 rounded-md bg-white px-3 py-1 text-xs font-medium text-black transition-all duration-200 hover:bg-neutral-200 disabled:opacity-50"
            >
              <Save size={12} />
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={cancelEditing}
              disabled={saving}
              className="rounded-md px-3 py-1 text-xs font-medium text-neutral-400 transition-all duration-200 hover:bg-[#222] hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Metadata picker */}
      {showMetadata && (
        <MetadataPicker
          currentTitle={item.title}
          currentArtist={item.artist}
          onApply={(m) =>
            applyMetadata(item.id, item.filePath!, m.title, m.artist, m.album, m.release_mbid)
          }
          onApplied={(result) => {
            updateDownload(item.id, {
              title: result.title,
              artist: result.artist,
              album: result.album,
              coverArtBase64: result.cover_art_base64 || undefined,
              filePath: result.new_file_path,
            });
          }}
          onClose={() => setShowMetadata(false)}
        />
      )}
    </div>
  );
}
