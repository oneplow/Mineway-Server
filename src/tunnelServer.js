"use strict";

const { WebSocketServer } = require("ws");
const http                = require("http");
const crypto              = require("crypto");
const { verifyKey }       = require("./keyVerifier");
const TunnelSession       = require("./tunnelSession");
const StatsReporter       = require("./statsReporter");
const logger              = require("./logger");

/**
 * TunnelServer — Port Allocation Architecture
 *
 * แต่ละ session (API Key) จะได้ port เฉพาะของตัวเอง
 * ใช้สำหรับทั้ง TCP (Java) และ UDP (Bedrock) พร้อมกัน
 *
 * ผู้เล่นเชื่อมที่ VPS_IP:ASSIGNED_PORT ทั้ง Java และ Bedrock
 * ไม่ต้อง parse Minecraft handshake หรือ routing ด้วย subdomain อีกต่อไป
 */
class TunnelServer {
  constructor({ wsPort, webApiUrl, webApiSecret, baseDomain }) {
    this.wsPort       = wsPort;
    this.webApiUrl    = webApiUrl;
    this.webApiSecret = webApiSecret;
    this.baseDomain   = baseDomain || process.env.BASE_DOMAIN || "mctunnel.io";

    // keyId -> TunnelSession
    this.sessions     = new Map();

    this.reporter = new StatsReporter({ webApiUrl, webApiSecret });
  }

  start() {
    // ─── HTTP + WebSocket server ───────────────────────────────────────
    this.httpServer = http.createServer((req, res) => this._handleHttp(req, res));
    this.wss        = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws, req) => {
      const ip = req.socket.remoteAddress;
      logger.info("Plugin WS connected", { ip });
      this._handlePlugin(ws, ip);
    });

    this.httpServer.listen(this.wsPort, "0.0.0.0", () => {
      logger.info("WS/HTTP server started", { port: this.wsPort });
    });

    logger.info("TunnelServer started (Port Allocation mode)", {
      wsPort:     this.wsPort,
      baseDomain: this.baseDomain,
    });
  }

  // ─── Handle plugin WebSocket connection ───────────────────────────
  async _handlePlugin(ws, ip) {
    let authed = false;

    const authTimeout = setTimeout(() => {
      if (!authed) {
        logger.warn("Auth timeout", { ip });
        ws.close(4001, "auth_timeout");
      }
    }, 10_000);

    ws.once("message", async (raw) => {
      clearTimeout(authTimeout);

      let msg;
      try { msg = JSON.parse(raw); }
      catch { ws.close(4002, "invalid_json"); return; }

      if (msg.type !== "auth" || !msg.key) {
        ws.close(4003, "expected_auth");
        return;
      }

      // ─── Verify key ──────────────────────────────────────────────
      const result = await verifyKey(msg.key, {
        webApiUrl:    this.webApiUrl,
        webApiSecret: this.webApiSecret,
      });

      if (!result.valid) {
        logger.warn("Auth failed", { ip, reason: result.reason });
        ws.send(JSON.stringify({ type: "auth_failed", reason: result.reason }));
        ws.close(4004, result.reason);
        return;
      }

      if (!result.assignedPort) {
        logger.warn("Key has no assigned port", { ip, keyId: result.keyId });
        ws.send(JSON.stringify({ type: "auth_failed", reason: "no_port_assigned" }));
        ws.close(4005, "no_port_assigned");
        return;
      }

      authed = true;

      const tunnelId = crypto
        .createHash("sha256")
        .update(result.keyId)
        .digest("hex")
        .slice(0, 8);

      // ─── Replace existing session ────────────────────────────────
      const existing = this.sessions.get(result.keyId);
      if (existing) {
        logger.warn("Replacing session", { tunnelId, keyId: result.keyId });
        existing.destroy("reconnected");
      }

      // ─── สร้าง session พร้อม dedicated port ───────────────────────
      const session = new TunnelSession({
        ws,
        keyId:        result.keyId,
        userId:       result.userId,
        tunnelId,
        assignedPort: result.assignedPort,
        plan:         result.plan,
        maxPlayers:   result.maxPlayers,
      });

      session.on("destroyed", async ({ keyId, userId, rxBytes, txBytes, reason }) => {
        this.sessions.delete(keyId);
        logger.info("Session ended", { tunnelId, keyId, userId, reason });
        await this.reporter.recordAndFlush(keyId, rxBytes, txBytes);
      });

      // start() จะ bind TCP+UDP บน assignedPort
      const ok = await session.start();
      if (!ok) {
        logger.error("Failed to start session (port bind failed)", {
          keyId: result.keyId,
          port: result.assignedPort,
        });
        ws.send(JSON.stringify({ type: "auth_failed", reason: "port_bind_failed" }));
        ws.close(4006, "port_bind_failed");
        return;
      }

      this.sessions.set(result.keyId, session);

      ws.send(JSON.stringify({
        type:     "auth_ok",
        tunnelId,
        hostname: `${this.baseDomain}`,
        tcpPort:  result.assignedPort,
        udpPort:  result.assignedPort,  // same port for both!
        plan:     result.plan,
      }));

      logger.info("Plugin authed", {
        tunnelId,
        assignedPort: result.assignedPort,
        keyId:        result.keyId,
        userId:       result.userId,
        plan:         result.plan,
        ip,
      });
    });
  }

  // ─── HTTP handlers ─────────────────────────────────────────────────
  _handleHttp(req, res) {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status:   "ok",
        sessions: this.sessions.size,
      }));
      return;
    }

    if (req.url === "/stats") {
      if (req.headers["x-internal-secret"] !== this.webApiSecret) {
        res.writeHead(401); res.end("Unauthorized"); return;
      }
      const sessions = [...this.sessions.values()].map((s) => s.stats());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    res.writeHead(404); res.end();
  }

  // ─── Stop ──────────────────────────────────────────────────────────
  stop() {
    logger.info("Stopping...");
    for (const s of this.sessions.values()) s.destroy("server_shutdown");
    this.sessions.clear();
    return new Promise((resolve) => {
      this.reporter.stop().then(() => {
        this.wss.close();
        this.httpServer.close(resolve);
      });
    });
  }
}

module.exports = TunnelServer;
