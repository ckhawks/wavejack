import { LogOut, Users, Download } from "lucide-react";
import { useRoomStore } from "../../stores/roomStore";
import { NowPlaying } from "./NowPlaying";
import { DjQueue } from "./DjQueue";
import { RoomChat } from "./RoomChat";

function GrabNotification() {
  const { grabUrl, grabTitle, grabArtist, serverUrl, clearGrab } = useRoomStore();

  if (!grabUrl) return null;

  const fullUrl = `${serverUrl}${grabUrl}`;

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = fullUrl;
    a.download = `${grabArtist} - ${grabTitle}.webm`;
    a.click();
    clearGrab();
  };

  return (
    <div className="flex items-center gap-2 border-b border-[#222] bg-violet-600/10 px-4 py-2">
      <Download size={14} className="text-violet-400" />
      <p className="flex-1 text-xs text-violet-300">
        Grabbed: {grabArtist} — {grabTitle}
      </p>
      <button
        onClick={handleDownload}
        className="rounded bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-500"
      >
        Save
      </button>
      <button
        onClick={clearGrab}
        className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-white"
      >
        Dismiss
      </button>
    </div>
  );
}

export function RoomView() {
  const { roomName, users, leaveRoom, connected } = useRoomStore();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Room header */}
      <div className="flex shrink-0 items-center justify-between border-b border-[#222] px-4 py-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white">{roomName}</h2>
          <div className="flex items-center gap-1 text-neutral-500">
            <Users size={12} />
            <span className="text-xs">{users.length}</span>
          </div>
          {!connected && (
            <span className="rounded bg-red-600/20 px-1.5 py-0.5 text-[10px] text-red-400">Disconnected</span>
          )}
        </div>
        <button
          onClick={leaveRoom}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-[#222] hover:text-white"
        >
          <LogOut size={12} />
          Leave
        </button>
      </div>

      {/* Grab notification */}
      <GrabNotification />

      {/* Main content: 2/3 left panel, 1/3 chat */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: now playing + DJ queue + users */}
        <div className="flex flex-[2] flex-col gap-4 overflow-y-auto border-r border-[#222] p-3">
          <NowPlaying />
          <DjQueue />

          {/* User list */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
              In Room ({users.length})
            </h3>
            <div className="flex flex-col gap-0.5">
              {users.map((u) => (
                <p key={u.id} className="text-xs text-neutral-400">
                  {u.name}
                </p>
              ))}
            </div>
          </div>
        </div>

        {/* Right panel: chat (1/3 width) */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <RoomChat />
        </div>
      </div>
    </div>
  );
}
