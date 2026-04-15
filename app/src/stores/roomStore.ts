import { create } from "zustand";
import { RoomWebSocket } from "../lib/ws";
import type { ChatMessage, ReactionState, ReactionType, RoomSummary, RoomUser, ServerMessage, TrackInfo } from "../lib/roomTypes";

interface RoomStore {
  // Connection
  serverUrl: string;
  connected: boolean;
  userName: string;
  userId: string | null;
  currentRoomId: string | null;

  // Room list
  rooms: RoomSummary[];
  loadingRooms: boolean;

  // Current room state
  roomName: string;
  users: RoomUser[];
  djQueue: string[];
  currentDj: string | null;
  currentTrack: TrackInfo | null;
  playbackStartedAt: number | null;
  chatMessages: ChatMessage[];
  reactions: ReactionState;

  // Upload state
  uploading: boolean;

  // Grab state
  grabUrl: string | null;
  grabTitle: string;
  grabArtist: string;

  // Actions
  setServerUrl: (url: string) => void;
  setUserName: (name: string) => void;
  loadRooms: () => Promise<void>;
  createRoom: (name: string) => Promise<string | null>;
  joinRoom: (roomId: string) => void;
  leaveRoom: () => void;
  sendChat: (text: string) => void;
  joinDjQueue: () => void;
  leaveDjQueue: () => void;
  uploadTrack: (file: File, title: string, artist: string) => Promise<void>;
  skipTrack: () => void;
  react: (reaction: ReactionType) => void;
  grabTrack: () => void;
  clearGrab: () => void;
}

const ws = new RoomWebSocket();

export const useRoomStore = create<RoomStore>((set, get) => {
  ws.onMessage((msg: ServerMessage) => {
    const state = get();

    switch (msg.type) {
      case "room_state":
        set({
          userId: msg.userId,
          roomName: msg.room.name,
          users: msg.users,
          djQueue: msg.djQueue,
          currentDj: msg.currentDj,
          currentTrack: msg.currentTrack,
          playbackStartedAt: msg.playbackStartedAt,
          chatMessages: [],
          reactions: { woots: [], mehs: [], grabs: [] },
        });
        break;

      case "user_joined":
        set({ users: [...state.users, msg.user] });
        break;

      case "user_left":
        set({ users: state.users.filter((u) => u.id !== msg.userId) });
        break;

      case "chat_message":
        set({ chatMessages: [...state.chatMessages.slice(-200), msg.message] });
        break;

      case "dj_queue_updated":
        set({ djQueue: msg.djQueue, currentDj: msg.currentDj });
        break;

      case "now_playing":
        set({
          currentTrack: msg.track,
          playbackStartedAt: msg.startedAt,
          reactions: { woots: [], mehs: [], grabs: [] },
        });
        break;

      case "track_ended":
        set({
          currentTrack: null,
          playbackStartedAt: null,
          reactions: { woots: [], mehs: [], grabs: [] },
        });
        break;

      case "reactions_updated":
        set({ reactions: msg.reactions });
        break;

      case "grab_url":
        set({ grabUrl: msg.url, grabTitle: msg.title, grabArtist: msg.artist });
        break;

      case "error":
        console.error("Room error:", msg.message);
        break;
    }
  });

  ws.onStatus((connected) => {
    set({ connected });
  });

  return {
    serverUrl: "http://localhost:7405",
    connected: false,
    userName: "",
    userId: null,
    currentRoomId: null,

    rooms: [],
    loadingRooms: false,

    roomName: "",
    users: [],
    djQueue: [],
    currentDj: null,
    currentTrack: null,
    playbackStartedAt: null,
    chatMessages: [],
    reactions: { woots: [], mehs: [], grabs: [] },

    uploading: false,

    grabUrl: null,
    grabTitle: "",
    grabArtist: "",

    setServerUrl: (url) => set({ serverUrl: url }),
    setUserName: (name) => set({ userName: name }),

    loadRooms: async () => {
      const { serverUrl } = get();
      set({ loadingRooms: true });
      try {
        const res = await fetch(`${serverUrl}/api/rooms`);
        const rooms = (await res.json()) as RoomSummary[];
        set({ rooms, loadingRooms: false });
      } catch {
        set({ loadingRooms: false });
      }
    },

    createRoom: async (name) => {
      const { serverUrl, userName } = get();
      try {
        const res = await fetch(`${serverUrl}/api/rooms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, userName }),
        });
        const data = (await res.json()) as { id: string };
        return data.id;
      } catch {
        return null;
      }
    },

    joinRoom: (roomId) => {
      const { serverUrl, userName } = get();
      set({ currentRoomId: roomId });
      ws.connect(serverUrl, roomId, userName);
    },

    leaveRoom: () => {
      ws.send({ type: "leave_room" });
      ws.disconnect();
      set({
        currentRoomId: null,
        userId: null,
        roomName: "",
        users: [],
        djQueue: [],
        currentDj: null,
        currentTrack: null,
        playbackStartedAt: null,
        chatMessages: [],
        reactions: { woots: [], mehs: [], grabs: [] },
      });
    },

    sendChat: (text) => {
      ws.send({ type: "chat", text });
    },

    joinDjQueue: () => {
      ws.send({ type: "join_dj_queue" });
    },

    leaveDjQueue: () => {
      ws.send({ type: "leave_dj_queue" });
    },

    uploadTrack: async (file, title, artist) => {
      const { serverUrl, currentRoomId } = get();
      if (!currentRoomId) return;

      set({ uploading: true });
      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch(`${serverUrl}/api/rooms/${currentRoomId}/upload`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const err = (await res.json()) as { error: string };
          throw new Error(err.error);
        }

        const data = (await res.json()) as {
          trackId: string;
          duration: number;
          title: string;
          artist: string;
          url: string;
        };

        // Use server-extracted metadata as fallback, user-provided takes priority
        ws.send({
          type: "upload_complete",
          trackId: data.trackId,
          title: title || data.title || file.name.replace(/\.[^.]+$/, ""),
          artist: artist || data.artist || "Unknown",
        });
      } finally {
        set({ uploading: false });
      }
    },

    skipTrack: () => {
      ws.send({ type: "skip" });
    },

    react: (reaction) => {
      ws.send({ type: "react", reaction });
    },

    grabTrack: () => {
      ws.send({ type: "grab_track" });
    },

    clearGrab: () => {
      set({ grabUrl: null, grabTitle: "", grabArtist: "" });
    },
  };
});
