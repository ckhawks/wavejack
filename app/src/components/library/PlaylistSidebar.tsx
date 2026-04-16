import { useState } from "react";
import { Plus, Trash2, Pencil, Check, X, Music, ListMusic } from "lucide-react";
import { usePlaylistStore } from "../../stores/playlistStore";

export function PlaylistSidebar() {
  const playlists = usePlaylistStore((s) => s.playlists);
  const activeId = usePlaylistStore((s) => s.activePlaylistId);
  const setActive = usePlaylistStore((s) => s.setActive);
  const create = usePlaylistStore((s) => s.create);
  const rename = usePlaylistStore((s) => s.rename);
  const remove = usePlaylistStore((s) => s.remove);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    await create(name);
    setNewName("");
    setCreating(false);
  };

  const handleRename = async (id: string) => {
    const name = renameValue.trim();
    if (!name) return;
    await rename(id, name);
    setRenamingId(null);
  };

  return (
    <div className="flex w-52 shrink-0 flex-col border-r border-[#222] bg-[#0a0a0a]">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-600">
          Playlists
        </span>
        <button
          onClick={() => setCreating(true)}
          className="rounded p-1 text-neutral-600 hover:text-white"
          title="New playlist"
        >
          <Plus size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* All Tracks */}
        <button
          onClick={() => setActive(null)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
            activeId === null
              ? "bg-[#1a1a1a] text-white"
              : "text-neutral-400 hover:bg-[#111] hover:text-white"
          }`}
        >
          <Music size={12} />
          All Tracks
        </button>

        {playlists.map((p) => (
          <div
            key={p.id}
            className={`group flex items-center gap-1 px-3 py-1.5 transition-colors ${
              activeId === p.id
                ? "bg-[#1a1a1a] text-white"
                : "text-neutral-400 hover:bg-[#111] hover:text-white"
            }`}
          >
            {renamingId === p.id ? (
              <div className="flex flex-1 items-center gap-1">
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename(p.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="flex-1 rounded bg-[#222] px-1.5 py-0.5 text-xs text-white outline-none"
                  autoFocus
                />
                <button onClick={() => handleRename(p.id)} className="text-green-400">
                  <Check size={10} />
                </button>
                <button onClick={() => setRenamingId(null)} className="text-neutral-600">
                  <X size={10} />
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setActive(p.id)}
                  className="flex flex-1 items-center gap-2 text-left text-xs"
                >
                  <ListMusic size={12} className="shrink-0" />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-neutral-600">
                    {p.track_count}
                  </span>
                </button>
                <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
                  <button
                    onClick={() => { setRenamingId(p.id); setRenameValue(p.name); }}
                    className="rounded p-0.5 text-neutral-600 hover:text-white"
                  >
                    <Pencil size={10} />
                  </button>
                  <button
                    onClick={() => remove(p.id)}
                    className="rounded p-0.5 text-neutral-600 hover:text-red-400"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}

        {/* Create new playlist inline */}
        {creating && (
          <div className="flex items-center gap-1 px-3 py-1.5">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="Playlist name..."
              className="flex-1 rounded bg-[#222] px-1.5 py-0.5 text-xs text-white placeholder-neutral-600 outline-none"
              autoFocus
            />
            <button onClick={handleCreate} className="text-green-400">
              <Check size={10} />
            </button>
            <button onClick={() => setCreating(false)} className="text-neutral-600">
              <X size={10} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
