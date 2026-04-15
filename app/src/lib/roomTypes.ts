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

export type ReactionType = "woot" | "meh" | "grab";

export interface ReactionState {
  woots: string[];
  mehs: string[];
  grabs: string[];
}

// Client-to-server messages
export type ClientMessage =
  | { type: "join_room"; roomId: string; userName: string }
  | { type: "leave_room" }
  | { type: "chat"; text: string }
  | { type: "join_dj_queue" }
  | { type: "leave_dj_queue" }
  | { type: "upload_complete"; trackId: string; title: string; artist: string }
  | { type: "skip" }
  | { type: "react"; reaction: ReactionType }
  | { type: "grab_track" };

// Server-to-client messages
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
