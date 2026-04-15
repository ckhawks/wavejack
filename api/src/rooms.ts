import { nanoid } from "nanoid";
import type { ReactionState, ReactionType, Room, RoomSummary, RoomUser, TrackInfo } from "./types.js";

export class RoomManager {
  private rooms = new Map<string, Room>();

  createRoom(name: string, createdBy: string): Room {
    const id = nanoid(8);
    const room: Room = {
      id,
      name,
      createdBy,
      djQueue: [],
      currentDj: null,
      currentTrack: null,
      playbackStartedAt: null,
      reactions: { woots: [], mehs: [], grabs: [] },
      users: new Map(),
    };
    this.rooms.set(id, room);
    return room;
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  deleteRoom(id: string): void {
    this.rooms.delete(id);
  }

  listRooms(): RoomSummary[] {
    return Array.from(this.rooms.values()).map((room) => ({
      id: room.id,
      name: room.name,
      userCount: room.users.size,
      currentTrack: room.currentTrack,
    }));
  }

  addUser(roomId: string, user: RoomUser): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.users.set(user.id, user);
    return true;
  }

  removeUser(roomId: string, userId: string): { roomEmpty: boolean; wasDj: boolean } {
    const room = this.rooms.get(roomId);
    if (!room) return { roomEmpty: true, wasDj: false };

    room.users.delete(userId);

    // Remove from DJ queue
    const queueIdx = room.djQueue.indexOf(userId);
    if (queueIdx !== -1) {
      room.djQueue.splice(queueIdx, 1);
    }

    const wasDj = room.currentDj === userId;
    if (wasDj) {
      room.currentDj = null;
      room.currentTrack = null;
      room.playbackStartedAt = null;
    }

    const roomEmpty = room.users.size === 0;
    if (roomEmpty) {
      this.rooms.delete(roomId);
    }

    return { roomEmpty, wasDj };
  }

  joinDjQueue(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.users.has(userId)) return false;
    if (room.djQueue.includes(userId)) return false;
    room.djQueue.push(userId);

    // If no current DJ, this user becomes the DJ
    if (!room.currentDj) {
      room.currentDj = userId;
    }

    return true;
  }

  leaveDjQueue(roomId: string, userId: string): { wasDj: boolean } {
    const room = this.rooms.get(roomId);
    if (!room) return { wasDj: false };

    const idx = room.djQueue.indexOf(userId);
    if (idx === -1) return { wasDj: false };

    room.djQueue.splice(idx, 1);

    const wasDj = room.currentDj === userId;
    if (wasDj) {
      room.currentDj = null;
      room.currentTrack = null;
      room.playbackStartedAt = null;
    }

    return { wasDj };
  }

  advanceDj(roomId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room || room.djQueue.length === 0) return null;

    // Rotate: move current DJ to end of queue
    if (room.currentDj && room.djQueue.includes(room.currentDj)) {
      const idx = room.djQueue.indexOf(room.currentDj);
      room.djQueue.splice(idx, 1);
      room.djQueue.push(room.currentDj);
    }

    // Next DJ is front of queue
    room.currentDj = room.djQueue[0] ?? null;
    room.currentTrack = null;
    room.playbackStartedAt = null;

    return room.currentDj;
  }

  setCurrentTrack(roomId: string, track: TrackInfo): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.currentTrack = track;
    room.playbackStartedAt = Date.now();
    room.reactions = { woots: [], mehs: [], grabs: [] };
    return true;
  }

  addReaction(roomId: string, userId: string, reaction: ReactionType): ReactionState | null {
    const room = this.rooms.get(roomId);
    if (!room || !room.currentTrack) return null;

    // Remove any existing reaction from this user
    room.reactions.woots = room.reactions.woots.filter((id) => id !== userId);
    room.reactions.mehs = room.reactions.mehs.filter((id) => id !== userId);
    room.reactions.grabs = room.reactions.grabs.filter((id) => id !== userId);

    // Add the new reaction
    if (reaction === "woot") room.reactions.woots.push(userId);
    else if (reaction === "meh") room.reactions.mehs.push(userId);
    else if (reaction === "grab") room.reactions.grabs.push(userId);

    return { ...room.reactions };
  }

  clearCurrentTrack(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.currentTrack = null;
    room.playbackStartedAt = null;
  }
}
