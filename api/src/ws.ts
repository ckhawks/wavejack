import type { WSContext } from "hono/ws";
import { nanoid } from "nanoid";
import type { RoomManager } from "./rooms.js";
import type { PlaybackTimer } from "./playback.js";
import { clientMessageSchema } from "./types.js";
import type { ClientMessage, ReactionType, RoomUser, ServerMessage } from "./types.js";
import { rmSync } from "node:fs";
import { join } from "node:path";

interface ConnInfo {
  userId: string;
  userName: string;
  roomId: string | null;
}

interface UploadMeta {
  duration: number;
  title: string;
  artist: string;
  album: string;
  coverArtUrl: string | null;
}

export class WsHandler {
  private connections = new Map<WSContext, ConnInfo>();
  private roomConnections = new Map<string, Set<WSContext>>();
  private uploadMeta = new Map<string, UploadMeta>();

  constructor(
    private rooms: RoomManager,
    private playback: PlaybackTimer,
    private uploadsDir: string,
  ) {}

  /** Called by the upload route to store metadata extracted by ffprobe */
  storeUploadMeta(roomId: string, trackId: string, meta: UploadMeta): void {
    this.uploadMeta.set(`${roomId}/${trackId}`, meta);
  }

  onOpen(ws: WSContext): void {
    this.connections.set(ws, { userId: nanoid(12), userName: "", roomId: null });
  }

  onClose(ws: WSContext): void {
    const info = this.connections.get(ws);
    if (info?.roomId) {
      this.handleLeaveRoom(ws, info);
    }
    this.connections.delete(ws);
  }

  onMessage(ws: WSContext, raw: string): void {
    const info = this.connections.get(ws);
    if (!info) return;

    let msg: ClientMessage;
    try {
      const parsed = JSON.parse(raw);
      msg = clientMessageSchema.parse(parsed);
    } catch {
      this.send(ws, { type: "error", message: "Invalid message format" });
      return;
    }

    switch (msg.type) {
      case "join_room":
        this.handleJoinRoom(ws, info, msg.roomId, msg.userName);
        break;
      case "leave_room":
        this.handleLeaveRoom(ws, info);
        break;
      case "chat":
        this.handleChat(ws, info, msg.text);
        break;
      case "join_dj_queue":
        this.handleJoinDjQueue(ws, info);
        break;
      case "leave_dj_queue":
        this.handleLeaveDjQueue(ws, info);
        break;
      case "upload_complete":
        this.handleUploadComplete(ws, info, msg.trackId, msg.title, msg.artist);
        break;
      case "skip":
        this.handleSkip(ws, info);
        break;
      case "react":
        this.handleReaction(ws, info, msg.reaction);
        break;
      case "grab_track":
        this.handleGrabTrack(ws, info);
        break;
    }
  }

  private handleJoinRoom(ws: WSContext, info: ConnInfo, roomId: string, userName: string): void {
    // Leave current room if in one
    if (info.roomId) {
      this.handleLeaveRoom(ws, info);
    }

    const room = this.rooms.getRoom(roomId);
    if (!room) {
      this.send(ws, { type: "error", message: "Room not found" });
      return;
    }

    info.userName = userName;
    info.roomId = roomId;

    const user: RoomUser = {
      id: info.userId,
      name: userName,
      joinedAt: Date.now(),
    };

    this.rooms.addUser(roomId, user);

    // Track connection for room broadcasts
    if (!this.roomConnections.has(roomId)) {
      this.roomConnections.set(roomId, new Set());
    }
    this.roomConnections.get(roomId)!.add(ws);

    // Send full room state to the joining user
    this.send(ws, {
      type: "room_state",
      room: {
        id: room.id,
        name: room.name,
        userCount: room.users.size,
        currentTrack: room.currentTrack,
      },
      users: Array.from(room.users.values()),
      djQueue: room.djQueue,
      currentDj: room.currentDj,
      currentTrack: room.currentTrack,
      playbackStartedAt: room.playbackStartedAt,
      userId: info.userId,
    });

    // Broadcast join to others
    this.broadcastToRoom(roomId, { type: "user_joined", user }, ws);
  }

  private handleLeaveRoom(ws: WSContext, info: ConnInfo): void {
    if (!info.roomId) return;

    const roomId = info.roomId;
    const { roomEmpty, wasDj } = this.rooms.removeUser(roomId, info.userId);

    // Remove from room connections
    const conns = this.roomConnections.get(roomId);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) {
        this.roomConnections.delete(roomId);
      }
    }

    info.roomId = null;

    if (roomEmpty) {
      this.playback.clearTrack(roomId);
      // Clean up uploads
      try {
        rmSync(join(this.uploadsDir, roomId), { recursive: true, force: true });
      } catch {}
      return;
    }

    this.broadcastToRoom(roomId, { type: "user_left", userId: info.userId });

    if (wasDj) {
      this.playback.clearTrack(roomId);
      this.advanceAndNotify(roomId);
    }
  }

  private handleChat(ws: WSContext, info: ConnInfo, text: string): void {
    if (!info.roomId) return;

    this.broadcastToRoom(info.roomId, {
      type: "chat_message",
      message: {
        userId: info.userId,
        userName: info.userName,
        text,
        timestamp: Date.now(),
      },
    });
  }

  private handleJoinDjQueue(ws: WSContext, info: ConnInfo): void {
    if (!info.roomId) return;

    const joined = this.rooms.joinDjQueue(info.roomId, info.userId);
    if (!joined) {
      this.send(ws, { type: "error", message: "Could not join DJ queue" });
      return;
    }

    const room = this.rooms.getRoom(info.roomId)!;
    this.broadcastToRoom(info.roomId, {
      type: "dj_queue_updated",
      djQueue: room.djQueue,
      currentDj: room.currentDj,
    });
  }

  private handleLeaveDjQueue(ws: WSContext, info: ConnInfo): void {
    if (!info.roomId) return;

    const { wasDj } = this.rooms.leaveDjQueue(info.roomId, info.userId);
    const room = this.rooms.getRoom(info.roomId);
    if (!room) return;

    this.broadcastToRoom(info.roomId, {
      type: "dj_queue_updated",
      djQueue: room.djQueue,
      currentDj: room.currentDj,
    });

    if (wasDj) {
      this.playback.clearTrack(info.roomId);
      this.advanceAndNotify(info.roomId);
    }
  }

  private handleUploadComplete(
    ws: WSContext,
    info: ConnInfo,
    trackId: string,
    title: string,
    artist: string,
  ): void {
    if (!info.roomId) return;

    const room = this.rooms.getRoom(info.roomId);
    if (!room || room.currentDj !== info.userId) {
      this.send(ws, { type: "error", message: "You are not the current DJ" });
      return;
    }

    // Look up stored metadata from the upload (duration, album, cover art)
    const stored = this.uploadMeta.get(`${info.roomId}/${trackId}`);
    const duration = stored?.duration ?? 0;
    const album = stored?.album ?? "";
    const coverArtUrl = stored?.coverArtUrl ?? null;

    const track = {
      id: trackId,
      title: title || stored?.title || "Unknown",
      artist: artist || stored?.artist || "Unknown",
      album,
      duration,
      url: `/uploads/${info.roomId}/${trackId}.webm`,
      coverArtUrl,
    };

    this.rooms.setCurrentTrack(info.roomId, track);

    this.broadcastToRoom(info.roomId, {
      type: "now_playing",
      track: room.currentTrack!,
      djId: info.userId,
      startedAt: room.playbackStartedAt!,
    });

    if (room.currentTrack!.duration > 0) {
      this.playback.startTrack(info.roomId, room.currentTrack!.duration, (roomId) => {
        this.onTrackEnd(roomId);
      });
    }
  }

  private handleSkip(ws: WSContext, info: ConnInfo): void {
    if (!info.roomId) return;

    const room = this.rooms.getRoom(info.roomId);
    if (!room) return;

    // Only current DJ or room creator can skip
    if (room.currentDj !== info.userId && room.createdBy !== info.userId) {
      this.send(ws, { type: "error", message: "Only the DJ or room owner can skip" });
      return;
    }

    this.playback.clearTrack(info.roomId);
    this.rooms.clearCurrentTrack(info.roomId);
    this.broadcastToRoom(info.roomId, { type: "track_ended" });
    this.advanceAndNotify(info.roomId);
  }

  private handleReaction(_ws: WSContext, info: ConnInfo, reaction: ReactionType): void {
    if (!info.roomId) return;

    const reactions = this.rooms.addReaction(info.roomId, info.userId, reaction);
    if (reactions) {
      this.broadcastToRoom(info.roomId, { type: "reactions_updated", reactions });
    }
  }

  private handleGrabTrack(ws: WSContext, info: ConnInfo): void {
    if (!info.roomId) return;

    const room = this.rooms.getRoom(info.roomId);
    if (!room?.currentTrack) {
      this.send(ws, { type: "error", message: "No track playing" });
      return;
    }

    // Also count as a "grab" reaction
    const reactions = this.rooms.addReaction(info.roomId, info.userId, "grab");
    if (reactions) {
      this.broadcastToRoom(info.roomId, { type: "reactions_updated", reactions });
    }

    // Send the audio file URL directly to the grabbing user
    this.send(ws, {
      type: "grab_url",
      url: room.currentTrack.url,
      title: room.currentTrack.title,
      artist: room.currentTrack.artist,
    });
  }

  private onTrackEnd(roomId: string): void {
    this.rooms.clearCurrentTrack(roomId);
    this.broadcastToRoom(roomId, { type: "track_ended" });
    this.advanceAndNotify(roomId);
  }

  private advanceAndNotify(roomId: string): void {
    const nextDj = this.rooms.advanceDj(roomId);
    const room = this.rooms.getRoom(roomId);
    if (!room) return;

    this.broadcastToRoom(roomId, {
      type: "dj_queue_updated",
      djQueue: room.djQueue,
      currentDj: nextDj,
    });
  }

  private send(ws: WSContext, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      // Send can throw if the socket closed between our connection-list scan
      // and this call. Not worth logging at error — clients drop all the
      // time. Keep at debug so it shows up if something else is going wrong.
      console.debug("[ws] send failed:", e);
    }
  }

  private broadcastToRoom(roomId: string, msg: ServerMessage, exclude?: WSContext): void {
    const conns = this.roomConnections.get(roomId);
    if (!conns) return;
    const data = JSON.stringify(msg);
    for (const ws of conns) {
      if (ws === exclude) continue;
      try {
        ws.send(data);
      } catch (e) {
        console.debug("[ws] broadcast send failed:", e);
      }
    }
  }
}
