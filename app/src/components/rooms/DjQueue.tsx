import { useRef, useState } from "react";
import { Disc3, Upload, LogOut, LogIn, Music, Search } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useRoomStore } from "../../stores/roomStore";
import { useLibraryStore } from "../../stores/libraryStore";

export function DjQueue() {
  const { djQueue, currentDj, userId, users, joinDjQueue, leaveDjQueue, uploadTrack, uploading } = useRoomStore();
  const currentTrack = useRoomStore((s) => s.currentTrack);
  const fileRef = useRef<HTMLInputElement>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");

  const libraryTracks = useLibraryStore((s) => s.tracks);

  const isInQueue = djQueue.includes(userId ?? "");
  const isCurrentDj = currentDj === userId;

  const getUserName = (id: string) => users.find((u) => u.id === id)?.name ?? "Unknown";

  const filteredLibrary = librarySearch.trim()
    ? libraryTracks.filter((t) => {
        const q = librarySearch.toLowerCase();
        return t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q);
      })
    : libraryTracks;

  const handleLibraryPick = async (track: { path: string; title: string; artist: string }) => {
    // Use Tauri's asset protocol to read local files
    const assetUrl = convertFileSrc(track.path);
    const res = await fetch(assetUrl);
    const blob = await res.blob();
    const filename = track.path.split(/[/\\]/).pop() || "track.mp3";
    const file = new File([blob], filename);
    await uploadTrack(file, track.title, track.artist);
    setShowLibrary(false);
    setLibrarySearch("");
  };

  const handleFilePick = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    await uploadTrack(file, "", "");
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">DJ Queue</h3>
        {isInQueue ? (
          <button
            onClick={leaveDjQueue}
            className="flex items-center gap-1 rounded bg-red-600/20 px-2 py-1 text-xs text-red-400 hover:bg-red-600/30"
          >
            <LogOut size={12} />
            Leave
          </button>
        ) : (
          <button
            onClick={joinDjQueue}
            className="flex items-center gap-1 rounded bg-violet-600/20 px-2 py-1 text-xs text-violet-400 hover:bg-violet-600/30"
          >
            <LogIn size={12} />
            Join
          </button>
        )}
      </div>

      {djQueue.length === 0 ? (
        <p className="text-xs text-neutral-600">Queue is empty — join to start DJing</p>
      ) : (
        <div className="flex flex-col gap-1">
          {djQueue.map((djId, i) => (
            <div
              key={djId}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs ${
                djId === currentDj ? "bg-violet-600/20 text-violet-300" : "text-neutral-400"
              }`}
            >
              {djId === currentDj && <Disc3 size={12} className="animate-spin" />}
              <span className={djId === userId ? "font-medium text-white" : ""}>
                {i + 1}. {getUserName(djId)}
                {djId === userId ? " (you)" : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Upload UI — shown when it's your turn and no track is playing */}
      {isCurrentDj && !currentTrack && (
        <div className="flex flex-col gap-2 rounded border border-violet-600/30 bg-violet-600/10 p-3">
          <p className="text-xs font-medium text-violet-300">Your turn! Pick a track:</p>

          {/* Library picker */}
          {libraryTracks.length > 0 && (
            <>
              <button
                onClick={() => setShowLibrary(!showLibrary)}
                className="flex items-center gap-1.5 rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
              >
                <Music size={12} />
                {showLibrary ? "Hide Library" : "Pick from Library"}
              </button>

              {showLibrary && (
                <div className="flex max-h-48 flex-col overflow-hidden rounded border border-[#333] bg-[#0a0a0a]">
                  <div className="flex items-center gap-1 border-b border-[#222] px-2 py-1">
                    <Search size={12} className="text-neutral-500" />
                    <input
                      type="text"
                      value={librarySearch}
                      onChange={(e) => setLibrarySearch(e.target.value)}
                      placeholder="Search library..."
                      className="flex-1 bg-transparent text-xs text-white outline-none"
                    />
                  </div>
                  <div className="overflow-y-auto">
                    {filteredLibrary.slice(0, 50).map((t) => (
                      <button
                        key={t.path}
                        onClick={() => handleLibraryPick(t)}
                        disabled={uploading}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-[#1a1a1a] disabled:opacity-40"
                      >
                        {t.cover_art_base64 ? (
                          <img src={`data:image/jpeg;base64,${t.cover_art_base64}`} alt="" className="h-6 w-6 rounded object-cover" />
                        ) : (
                          <div className="flex h-6 w-6 items-center justify-center rounded bg-[#222]">
                            <Music size={10} className="text-neutral-600" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-white">{t.title}</p>
                          <p className="truncate text-neutral-500">{t.artist || "Unknown"}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Fallback file picker */}
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              className="min-w-0 flex-1 text-xs text-neutral-400 file:mr-2 file:rounded file:border-0 file:bg-[#222] file:px-2 file:py-1 file:text-xs file:text-neutral-300"
            />
            <button
              onClick={handleFilePick}
              disabled={uploading}
              className="flex shrink-0 items-center gap-1 rounded bg-[#333] px-2 py-1.5 text-xs text-white hover:bg-[#444] disabled:opacity-40"
            >
              <Upload size={12} />
              {uploading ? "..." : "Upload"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
