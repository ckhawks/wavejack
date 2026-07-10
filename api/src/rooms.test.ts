import { beforeEach, describe, expect, it } from "vitest";
import { RoomManager } from "./rooms.js";
import type { RoomUser, TrackInfo } from "./types.js";

const user = (id: string): RoomUser => ({ id, name: id.toUpperCase(), joinedAt: 0 });

const track = (id: string): TrackInfo => ({
  id,
  title: `title-${id}`,
  artist: "artist",
  album: "album",
  duration: 180,
  url: `https://example.test/${id}`,
  coverArtUrl: null,
});

describe("RoomManager", () => {
  let rm: RoomManager;
  let roomId: string;

  beforeEach(() => {
    rm = new RoomManager();
    roomId = rm.createRoom("test-room", "u1").id;
  });

  it("creates an empty room with sane defaults", () => {
    const room = rm.getRoom(roomId);
    expect(room).toBeDefined();
    expect(room?.djQueue).toEqual([]);
    expect(room?.currentDj).toBeNull();
    expect(room?.currentTrack).toBeNull();
    expect(room?.users.size).toBe(0);
  });

  describe("DJ queue", () => {
    beforeEach(() => {
      rm.addUser(roomId, user("u1"));
      rm.addUser(roomId, user("u2"));
    });

    it("makes the first joiner the current DJ", () => {
      expect(rm.joinDjQueue(roomId, "u1")).toBe(true);
      expect(rm.getRoom(roomId)?.currentDj).toBe("u1");
    });

    it("rejects a non-member joining the queue", () => {
      expect(rm.joinDjQueue(roomId, "ghost")).toBe(false);
    });

    it("rejects a duplicate queue join", () => {
      rm.joinDjQueue(roomId, "u1");
      expect(rm.joinDjQueue(roomId, "u1")).toBe(false);
    });

    it("rotates the current DJ to the back of the queue on advance", () => {
      rm.joinDjQueue(roomId, "u1");
      rm.joinDjQueue(roomId, "u2");
      expect(rm.getRoom(roomId)?.currentDj).toBe("u1");

      expect(rm.advanceDj(roomId)).toBe("u2");
      expect(rm.getRoom(roomId)?.djQueue).toEqual(["u2", "u1"]);
    });

    it("keeps currentDj a member of djQueue after advancing (invariant)", () => {
      rm.joinDjQueue(roomId, "u1");
      rm.joinDjQueue(roomId, "u2");
      rm.advanceDj(roomId);
      const room = rm.getRoom(roomId);
      expect(room?.djQueue).toContain(room?.currentDj);
    });

    it("returns null when advancing an empty queue", () => {
      expect(rm.advanceDj(roomId)).toBeNull();
    });

    it("clears DJ state when the current DJ leaves the queue", () => {
      rm.joinDjQueue(roomId, "u1");
      expect(rm.leaveDjQueue(roomId, "u1")).toEqual({ wasDj: true });
      expect(rm.getRoom(roomId)?.currentDj).toBeNull();
    });
  });

  describe("reactions", () => {
    beforeEach(() => {
      rm.addUser(roomId, user("u1"));
    });

    it("ignores reactions when no track is playing", () => {
      expect(rm.addReaction(roomId, "u1", "woot")).toBeNull();
    });

    it("records exactly one reaction per user (switching replaces the prior)", () => {
      rm.setCurrentTrack(roomId, track("t1"));
      rm.addReaction(roomId, "u1", "woot");
      const state = rm.addReaction(roomId, "u1", "meh");
      expect(state?.woots).not.toContain("u1");
      expect(state?.mehs).toEqual(["u1"]);
    });

    it("resets all reactions when a new track starts", () => {
      rm.setCurrentTrack(roomId, track("t1"));
      rm.addReaction(roomId, "u1", "grab");
      rm.setCurrentTrack(roomId, track("t2"));
      expect(rm.getRoom(roomId)?.reactions).toEqual({ woots: [], mehs: [], grabs: [] });
    });
  });

  describe("removeUser", () => {
    it("hands off the DJ role and reports wasDj when the current DJ leaves", () => {
      rm.addUser(roomId, user("u1"));
      rm.joinDjQueue(roomId, "u1");
      expect(rm.removeUser(roomId, "u1")).toEqual({ roomEmpty: true, wasDj: true });
    });

    it("deletes the room once the last user leaves", () => {
      rm.addUser(roomId, user("u1"));
      expect(rm.removeUser(roomId, "u1").roomEmpty).toBe(true);
      expect(rm.getRoom(roomId)).toBeUndefined();
    });

    it("keeps the room alive and drops the leaver from the DJ queue", () => {
      rm.addUser(roomId, user("u1"));
      rm.addUser(roomId, user("u2"));
      rm.joinDjQueue(roomId, "u1");
      rm.joinDjQueue(roomId, "u2");

      expect(rm.removeUser(roomId, "u2")).toEqual({ roomEmpty: false, wasDj: false });
      expect(rm.getRoom(roomId)?.djQueue).toEqual(["u1"]);
    });
  });
});
