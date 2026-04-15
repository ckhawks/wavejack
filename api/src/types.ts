import { z } from "zod/v4";

// --- Room & User types ---

export interface RoomUser {
  id: string;
  name: string;
  joinedAt: number;
}

export interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  url: string;
  coverArtUrl: string | null;
}

export type ReactionType = "woot" | "meh" | "grab";

export interface ReactionState {
  woots: string[];  // user IDs
  mehs: string[];
  grabs: string[];
}

export interface Room {
  id: string;
  name: string;
  createdBy: string;
  djQueue: string[];
  currentDj: string | null;
  currentTrack: TrackInfo | null;
  playbackStartedAt: number | null;
  reactions: ReactionState;
  users: Map<string, RoomUser>;
}

export interface RoomSummary {
  id: string;
  name: string;
  userCount: number;
  currentTrack: TrackInfo | null;
}

export interface ChatMessage {
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
}

// --- WebSocket message schemas ---

const joinRoomSchema = z.object({
  type: z.literal("join_room"),
  roomId: z.string(),
  userName: z.string().min(1).max(32),
});

const leaveRoomSchema = z.object({
  type: z.literal("leave_room"),
});

const chatSchema = z.object({
  type: z.literal("chat"),
  text: z.string().min(1).max(500),
});

const joinDjQueueSchema = z.object({
  type: z.literal("join_dj_queue"),
});

const leaveDjQueueSchema = z.object({
  type: z.literal("leave_dj_queue"),
});

const uploadCompleteSchema = z.object({
  type: z.literal("upload_complete"),
  trackId: z.string(),
  title: z.string(),
  artist: z.string(),
});

const skipSchema = z.object({
  type: z.literal("skip"),
});

const reactSchema = z.object({
  type: z.literal("react"),
  reaction: z.enum(["woot", "meh", "grab"]),
});

const grabTrackSchema = z.object({
  type: z.literal("grab_track"),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinRoomSchema,
  leaveRoomSchema,
  chatSchema,
  joinDjQueueSchema,
  leaveDjQueueSchema,
  uploadCompleteSchema,
  skipSchema,
  reactSchema,
  grabTrackSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Server-to-client messages (no schema needed, we construct these)

export type ServerMessage =
  | { type: "room_state"; room: RoomSummary; users: RoomUser[]; djQueue: string[]; currentDj: string | null; currentTrack: TrackInfo | null; playbackStartedAt: number | null; userId: string }
  | { type: "user_joined"; user: RoomUser }
  | { type: "user_left"; userId: string }
  | { type: "chat_message"; message: ChatMessage }
  | { type: "dj_queue_updated"; djQueue: string[]; currentDj: string | null }
  | { type: "now_playing"; track: TrackInfo; djId: string; startedAt: number }
  | { type: "track_ended" }
  | { type: "reactions_updated"; reactions: ReactionState }
  | { type: "grab_url"; url: string; title: string; artist: string }
  | { type: "error"; message: string };
