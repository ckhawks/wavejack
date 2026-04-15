import { useEffect, useState } from "react";
import { Plus, RefreshCw, Users, Music } from "lucide-react";
import { useRoomStore } from "../../stores/roomStore";

export function RoomBrowser() {
  const { rooms, loadingRooms, loadRooms, createRoom, joinRoom, serverUrl, setServerUrl, userName, setUserName } = useRoomStore();
  const [showCreate, setShowCreate] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const handleCreate = async () => {
    if (!newRoomName.trim() || !userName.trim()) return;
    const id = await createRoom(newRoomName.trim());
    if (id) {
      setShowCreate(false);
      setNewRoomName("");
      joinRoom(id);
    }
  };

  const handleJoin = (roomId: string) => {
    if (!userName.trim()) return;
    joinRoom(roomId);
  };

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-hidden">
      {/* Connection settings */}
      <div className="flex gap-2">
        <input
          type="text"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="Server URL"
          className="flex-1 rounded bg-[#111] px-3 py-2 text-xs text-white outline-none ring-1 ring-[#333] focus:ring-[#555]"
        />
        <input
          type="text"
          value={userName}
          onChange={(e) => setUserName(e.target.value)}
          placeholder="Your name"
          className="w-40 rounded bg-[#111] px-3 py-2 text-xs text-white outline-none ring-1 ring-[#333] focus:ring-[#555]"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowCreate(true)}
          disabled={!userName.trim()}
          className="flex items-center gap-1.5 rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
        >
          <Plus size={14} />
          Create Room
        </button>
        <button
          onClick={loadRooms}
          className="flex items-center gap-1.5 rounded bg-[#222] px-3 py-1.5 text-xs text-neutral-300 hover:bg-[#333]"
        >
          <RefreshCw size={14} className={loadingRooms ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Create room modal */}
      {showCreate && (
        <div className="flex items-center gap-2 rounded border border-[#333] bg-[#111] p-3">
          <input
            type="text"
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="Room name"
            autoFocus
            className="flex-1 rounded bg-[#0a0a0a] px-3 py-1.5 text-xs text-white outline-none ring-1 ring-[#333] focus:ring-violet-500"
          />
          <button
            onClick={handleCreate}
            disabled={!newRoomName.trim()}
            className="rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
          >
            Create
          </button>
          <button
            onClick={() => setShowCreate(false)}
            className="rounded px-2 py-1.5 text-xs text-neutral-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Room list */}
      <div className="flex-1 overflow-y-auto">
        {rooms.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-neutral-500">
            <Music size={32} />
            <p className="text-sm">No rooms yet</p>
            <p className="text-xs">Create one to get started</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => handleJoin(room.id)}
                disabled={!userName.trim()}
                className="flex items-center justify-between rounded border border-[#222] bg-[#111] p-3 text-left transition-colors hover:border-[#444] hover:bg-[#1a1a1a] disabled:opacity-40"
              >
                <div>
                  <p className="text-sm font-medium text-white">{room.name}</p>
                  {room.currentTrack && (
                    <p className="mt-0.5 text-xs text-neutral-400">
                      {room.currentTrack.artist} — {room.currentTrack.title}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 text-neutral-500">
                  <Users size={14} />
                  <span className="text-xs">{room.userCount}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
