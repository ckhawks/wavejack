import { Hono } from "hono";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { RoomManager } from "./rooms.js";
import type { WsHandler } from "./ws.js";
import { transcodeAudio } from "./transcode.js";

const MAX_UPLOAD_SIZE = 15 * 1024 * 1024; // 15MB

// Audio magic bytes for validation
const AUDIO_SIGNATURES: Array<{ bytes: number[]; offset: number }> = [
  { bytes: [0xff, 0xfb], offset: 0 },          // MP3
  { bytes: [0xff, 0xf3], offset: 0 },          // MP3
  { bytes: [0xff, 0xf2], offset: 0 },          // MP3
  { bytes: [0x49, 0x44, 0x33], offset: 0 },    // ID3 (MP3 with tags)
  { bytes: [0x66, 0x4c, 0x61, 0x43], offset: 0 }, // FLAC
  { bytes: [0x4f, 0x67, 0x67, 0x53], offset: 0 }, // OGG
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // WAV/RIFF
  { bytes: [0x00, 0x00, 0x00], offset: 1 },    // M4A/AAC (ftyp box, byte 0 varies)
];

function isAudioFile(buffer: Uint8Array): boolean {
  // Check ftyp box for M4A/MP4 audio
  if (buffer.length > 8) {
    const ftypStr = String.fromCharCode(...buffer.slice(4, 8));
    if (ftypStr === "ftyp") return true;
  }

  for (const sig of AUDIO_SIGNATURES) {
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[sig.offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

export function createRoutes(rooms: RoomManager, uploadsDir: string, wsHandler: WsHandler): Hono {
  const api = new Hono();

  // List rooms
  api.get("/rooms", (c) => {
    return c.json(rooms.listRooms());
  });

  // Get room details
  api.get("/rooms/:id", (c) => {
    const room = rooms.getRoom(c.req.param("id"));
    if (!room) return c.json({ error: "Room not found" }, 404);

    return c.json({
      id: room.id,
      name: room.name,
      userCount: room.users.size,
      djQueue: room.djQueue,
      currentDj: room.currentDj,
      currentTrack: room.currentTrack,
      playbackStartedAt: room.playbackStartedAt,
      users: Array.from(room.users.values()),
    });
  });

  // Create room
  api.post("/rooms", async (c) => {
    const body = await c.req.json<{ name: string; userName: string }>();

    if (!body.name || body.name.length > 64) {
      return c.json({ error: "Room name is required (max 64 chars)" }, 400);
    }

    const room = rooms.createRoom(body.name.trim(), body.userName || "anonymous");
    return c.json({ id: room.id, name: room.name }, 201);
  });

  // Upload track for a room
  api.post("/rooms/:id/upload", async (c) => {
    const roomId = c.req.param("id");
    const room = rooms.getRoom(roomId);
    if (!room) return c.json({ error: "Room not found" }, 404);

    const contentLength = parseInt(c.req.header("content-length") || "0");
    if (contentLength > MAX_UPLOAD_SIZE) {
      return c.json({ error: "File too large (max 15MB)" }, 413);
    }

    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file provided" }, 400);
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      return c.json({ error: "File too large (max 15MB)" }, 413);
    }

    const buffer = new Uint8Array(await file.arrayBuffer());

    // Validate magic bytes
    if (!isAudioFile(buffer)) {
      return c.json({ error: "Not a recognized audio file" }, 400);
    }

    const trackId = nanoid(10);
    const roomUploadDir = join(uploadsDir, roomId);
    await mkdir(roomUploadDir, { recursive: true });

    // Write temp input file
    const ext = file.name.split(".").pop() || "mp3";
    const inputPath = join(roomUploadDir, `${trackId}_input.${ext}`);
    const outputPath = join(roomUploadDir, `${trackId}.webm`);

    await writeFile(inputPath, buffer);

    try {
      const result = await transcodeAudio(inputPath, outputPath);
      const coverArtUrl = result.metadata.hasCoverArt
        ? `/uploads/${roomId}/${trackId}_cover.jpg`
        : null;

      // Store metadata for when the DJ signals upload_complete via WS
      wsHandler.storeUploadMeta(roomId, trackId, {
        duration: result.duration,
        title: result.metadata.title,
        artist: result.metadata.artist,
        album: result.metadata.album,
        coverArtUrl,
      });

      return c.json({
        trackId,
        duration: result.duration,
        title: result.metadata.title,
        artist: result.metadata.artist,
        album: result.metadata.album,
        coverArtUrl,
        url: `/uploads/${roomId}/${trackId}.webm`,
      }, 201);
    } catch (err) {
      return c.json({ error: `Transcode failed: ${err instanceof Error ? err.message : "unknown"}` }, 500);
    }
  });

  return api;
}
