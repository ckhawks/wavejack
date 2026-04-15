import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { serveStatic } from "@hono/node-server/serve-static";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

import { RoomManager } from "./rooms.js";
import { PlaybackTimer } from "./playback.js";
import { WsHandler } from "./ws.js";
import { createRoutes } from "./routes.js";
import { checkFfmpeg } from "./transcode.js";

const PORT = parseInt(process.env.PORT || "7405");
const UPLOADS_DIR = resolve(process.env.UPLOADS_DIR || join(import.meta.dirname, "..", "uploads"));

// Ensure uploads directory exists
mkdirSync(UPLOADS_DIR, { recursive: true });

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Middleware
app.use("*", cors());

// State
const rooms = new RoomManager();
const playback = new PlaybackTimer();
const wsHandler = new WsHandler(rooms, playback, UPLOADS_DIR);

// REST API
const apiRoutes = createRoutes(rooms, UPLOADS_DIR, wsHandler);
app.route("/api", apiRoutes);

// Static file serving for transcoded uploads
app.use("/uploads/*", serveStatic({ root: UPLOADS_DIR, rewriteRequestPath: (path) => path.replace("/uploads", "") }));

// WebSocket endpoint
app.get("/ws", upgradeWebSocket(() => ({
  onOpen: (_event, ws) => {
    wsHandler.onOpen(ws);
  },
  onMessage: (event, ws) => {
    if (typeof event.data === "string") {
      wsHandler.onMessage(ws, event.data);
    }
  },
  onClose: (_event, ws) => {
    wsHandler.onClose(ws);
  },
})));

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Start server
async function main() {
  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    console.warn("WARNING: ffmpeg not found in PATH. Audio transcoding will fail.");
    console.warn("Install ffmpeg: https://ffmpeg.org/download.html");
  }

  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Wavejack API running on http://localhost:${info.port}`);
    console.log(`WebSocket: ws://localhost:${info.port}/ws`);
    console.log(`Uploads: ${UPLOADS_DIR}`);
  });

  injectWebSocket(server);
}

main().catch(console.error);
