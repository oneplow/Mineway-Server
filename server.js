"use strict";
require("dotenv").config();

const { WebSocketServer } = require("ws");
const http = require("http");
const crypto = require("crypto");

const logger = require("./lib/logger");
const { verifyKey } = require("./lib/keyVerifier");
const StatsReporter = require("./lib/stats");
const TunnelSession = require("./lib/session");

// ─── Config ──────────────────────────────────────────────────────────────
const WS_PORT = parseInt(process.env.WS_PORT || "8765");
const WEB_API_URL = process.env.WEB_API_URL || "http://localhost:3000";
const API_SECRET = process.env.INTERNAL_SECRET || "change-me";
const BASE_DOMAIN = process.env.BASE_DOMAIN || "mineway.cloud";

// ─── State ───────────────────────────────────────────────────────────────
const sessions = new Map(); // keyId -> TunnelSession
const reporter = new StatsReporter({ webApiUrl: WEB_API_URL, webApiSecret: API_SECRET });

// ─── HTTP ────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
    return;
  }
  if (req.url === "/stats" && req.headers["x-internal-secret"] === API_SECRET) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [...sessions.values()].map((s) => s.stats()) }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ─── WebSocket ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  let authed = false;

  const timeout = setTimeout(() => {
    if (!authed) ws.close(4001, "auth_timeout");
  }, 10_000);

  ws.once("message", async (raw) => {
    clearTimeout(timeout);

    let msg;
    try { msg = JSON.parse(raw); } catch { ws.close(4002, "invalid_json"); return; }
    if (msg.type !== "auth" || !msg.key) { ws.close(4003, "expected_auth"); return; }

    // Verify
    const result = await verifyKey(msg.key, { webApiUrl: WEB_API_URL, webApiSecret: API_SECRET });

    if (!result.valid) {
      ws.send(JSON.stringify({ type: "auth_failed", reason: result.reason }));
      ws.close(4004, result.reason);
      return;
    }
    if (!result.assignedPort) {
      ws.send(JSON.stringify({ type: "auth_failed", reason: "no_port_assigned" }));
      ws.close(4005, "no_port_assigned");
      return;
    }

    authed = true;
    const tunnelId = crypto.createHash("sha256").update(result.keyId).digest("hex").slice(0, 8);

    // Kick existing session for same key
    if (sessions.has(result.keyId)) {
      sessions.get(result.keyId).destroy("reconnected");
    }

    // Create session
    const session = new TunnelSession({
      ws,
      keyId: result.keyId,
      userId: result.userId,
      tunnelId,
      assignedPort: result.assignedPort,
      plan: result.plan,
      maxPlayers: result.maxPlayers,
    });

    session.on("destroyed", async ({ keyId, rxBytes, txBytes }) => {
      sessions.delete(keyId);
      await reporter.recordAndFlush(keyId, rxBytes, txBytes);
    });

    const ok = await session.start();
    if (!ok) {
      ws.send(JSON.stringify({ type: "auth_failed", reason: "port_bind_failed" }));
      ws.close(4006, "port_bind_failed");
      return;
    }

    sessions.set(result.keyId, session);

    ws.send(JSON.stringify({
      type: "auth_ok",
      tunnelId,
      hostname: result.subdomain || BASE_DOMAIN,
      tcpPort: result.assignedPort,
      udpPort: result.assignedPort,
      plan: result.plan,
    }));

    logger.info("Plugin authed", { tunnelId, port: result.assignedPort, ip });
  });
});

// ─── Start ───────────────────────────────────────────────────────────────
httpServer.listen(WS_PORT, "0.0.0.0", () => {
  logger.info("Mineway Server started", { port: WS_PORT, domain: BASE_DOMAIN });
});

// ─── Shutdown ────────────────────────────────────────────────────────────
async function shutdown() {
  logger.info("Shutting down...");
  for (const s of sessions.values()) s.destroy("server_shutdown");
  sessions.clear();
  await reporter.stop();
  wss.close();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => logger.error("Uncaught", { error: err.message }));
process.on("unhandledRejection", (r) => logger.error("Unhandled", { reason: String(r) }));
