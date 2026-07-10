import { useMemo, useState } from "react";
import { X, Save, SplitSquareHorizontal } from "lucide-react";
import { updateLibraryTrack, type LibraryTrack } from "../lib/commands";
import { useLibraryStore } from "../stores/libraryStore";
import { parseArtistTitle, sanitizeForFilename } from "../lib/metadataParse";

interface ManualEditModalProps {
  track: LibraryTrack;
  onClose: () => void;
}

/**
 * Manual metadata editor. Extracted from LibraryView so that keystrokes in
 * these inputs re-render only this small modal — previously the edit state
 * lived on LibraryView, so every character retyped the entire (600+ row)
 * track table, which made the fields feel laggy.
 */
export function ManualEditModal({ track, onClose }: ManualEditModalProps) {
  const [title, setTitle] = useState(track.title || "");
  const [artist, setArtist] = useState(track.artist || "");
  const [album, setAlbum] = useState(track.album || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Read-only preview of the filename the backend will rename to on save.
  const previewFilename = useMemo(() => {
    const ext = (track.filename.match(/\.[^./\\]+$/) || [""])[0];
    if (!artist.trim() || !title.trim()) return track.filename;
    return `${sanitizeForFilename(artist.trim())} - ${sanitizeForFilename(title.trim())}${ext}`;
  }, [track.filename, artist, title]);

  const handleParse = () => {
    const candidates = [track.title || "", track.filename || ""];
    for (const c of candidates) {
      const parsed = parseArtistTitle(c);
      if (parsed) {
        setArtist(parsed.artist);
        setTitle(parsed.title);
        return;
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const newPath = await updateLibraryTrack(track.path, title, artist, album, track.filename);
      // Patch just this row instead of reloading the whole library (600+ rows of
      // base64 cover art). The backend renames to "{artist} - {title}.{ext}".
      const filename = newPath.split(/[/\\]/).pop() || track.filename;
      useLibraryStore.getState().patchTrack(track.path, {
        path: newPath,
        filename,
        title,
        artist,
        album,
      });
      onClose();
    } catch (e: unknown) {
      const raw = e as { message?: string } | string | undefined;
      const msg = typeof raw === "string" ? raw : raw?.message ?? JSON.stringify(e);
      console.error("Failed to save metadata:", e);
      const hint = msg.toLowerCase().includes("file not found")
        ? " — the cached row is stale. Click Rescan to clean it up."
        : "";
      setSaveError(msg + hint);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-lg space-y-3 rounded-lg border border-[#333] bg-[#0a0a0a] p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-white">Edit metadata</p>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">
            <X size={14} />
          </button>
        </div>
        <p className="truncate text-xs text-neutral-500" title={track.path}>
          {track.path}
        </p>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-full rounded border border-[#333] bg-[#111] px-2 py-1.5 text-sm text-white placeholder-neutral-600 outline-none focus:border-neutral-500"
        />
        <input
          type="text"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          placeholder="Artist"
          className="w-full rounded border border-[#333] bg-[#111] px-2 py-1.5 text-sm text-white placeholder-neutral-600 outline-none focus:border-neutral-500"
        />
        <input
          type="text"
          value={album}
          onChange={(e) => setAlbum(e.target.value)}
          placeholder="Album"
          className="w-full rounded border border-[#333] bg-[#111] px-2 py-1.5 text-sm text-white placeholder-neutral-600 outline-none focus:border-neutral-500"
        />
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-neutral-600">Filename (auto)</p>
          <div className="w-full truncate rounded border border-[#222] bg-[#0a0a0a] px-2 py-1.5 text-sm text-neutral-500" title={previewFilename}>
            {previewFilename || "—"}
          </div>
        </div>
        {saveError && (
          <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-400">
            {saveError}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={handleParse}
            disabled={saving}
            className="flex items-center gap-1 rounded-md border border-[#333] px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:border-[#555] hover:text-white disabled:opacity-50"
            title="Split 'Artist - Title' from the filename"
          >
            <SplitSquareHorizontal size={12} />
            Parse
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:bg-[#222] hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-neutral-200 disabled:opacity-50"
          >
            <Save size={12} />
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
