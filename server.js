"use strict";
require("dotenv").config();

const http = require("http");
const { WebSocketServer } = require("ws");

const logger              = require("./lib/logger");
const StatsReporter       = require("./lib/stats");
const { createHttpHandler } = require("./controllers/httpController");
const { createWsHandler }   = require("./controllers/wsController");

// ─── Config ──────────────────────────────────────────────────────────────
const WS_PORT     = parseInt(process.env.WS_PORT || "8765", 10);
const WEB_API_URL = process.env.WEB_API_URL || "http://localhost:3000";
const NODE_TOKEN  = process.env.NODE_TOKEN || "change-me";
const BASE_DOMAIN = process.env.BASE_DOMAIN || "mineway.cloud";

// ─── State ───────────────────────────────────────────────────────────────
const sessions = new Map(); // keyId -> TunnelSession

// ─── Usage Reporter ──────────────────────────────────────────────────────
const reporter = new StatsReporter({
  webApiUrl: WEB_API_URL,
  nodeToken: NODE_TOKEN,
  onEnforcement: async ({ keyId, reason }) => {
    const session = sessions.get(keyId);
    if (!session) return;
    logger.warn("Disconnecting session due to quota", { keyId, reason });
    session.suspend();
    session.destroy(reason || "quota_exceeded");
    sessions.delete(keyId);
  },
});

// ─── HTTP Server ─────────────────────────────────────────────────────────
const httpServer = http.createServer(createHttpHandler(sessions, NODE_TOKEN));

// ─── WebSocket Server ────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", createWsHandler({
  sessions,
  reporter,
  webApiUrl:  WEB_API_URL,
  nodeToken:  NODE_TOKEN,
  baseDomain: BASE_DOMAIN,
}));

// ─── Start ───────────────────────────────────────────────────────────────
httpServer.listen(WS_PORT, "0.0.0.0", () => {
  logger.info("Mineway Server started", { port: WS_PORT, domain: BASE_DOMAIN });
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────
async function shutdown() {
  logger.info("Shutting down...");
  for (const s of sessions.values()) s.destroy("server_shutdown");
  sessions.clear();
  await reporter.stop();
  wss.close();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException",  (err) => logger.error("Uncaught", { error: err.message, stack: err.stack }));
process.on("unhandledRejection", (r)   => logger.error("Unhandled", { reason: String(r) }));
