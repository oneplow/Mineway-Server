"use strict";

const { WebSocketServer } = require("ws");
const http                = require("http");
const crypto              = require("crypto");
const { verifyKey }       = require("./keyVerifier");
const TunnelSession       = require("./tunnelSession");
const TCPDispatcher       = require("./tcpDispatcher");
const UDPDispatcher       = require("./udpDispatcher");
const StatsReporter       = require("./statsReporter");
const logger              = require("./logger");

class TunnelServer {
  constructor({ wsPort, tcpPort, webApiUrl, webApiSecret, baseDomain }) {
    this.wsPort       = wsPort;
    this.tcpPort      = tcpPort || 25565;
    this.webApiUrl    = webApiUrl;
    this.webApiSecret = webApiSecret;
    this.baseDomain   = baseDomain || process.env.BASE_DOMAIN || "mctunnel.io";

    // tunnelId (subdomain) -> TunnelSession
    this.sessions     = new Map();
    // keyId -> TunnelSession (lookup อีกทาง)
    this.sessionByKey = new Map();

    this.reporter = new StatsReporter({ webApiUrl, webApiSecret });

    // TCP Dispatcher — Java Edition, port 25565 เดียว
    this.tcpDispatcher = new TCPDispatcher({
      port:        this.tcpPort,
      baseDomain:  this.baseDomain,
      findSession: (tunnelId) => this.sessions.get(tunnelId) || null,
    });

    // UDP Dispatcher — Bedrock Edition, port pool 19200-19999
    this.udpDispatcher = new UDPDispatcher({
      findSessionByPort: (port) => {
        // หา session จาก udpPort
        for (const s of this.sessions.values()) {
          if (s.udpPort === port) return s;
        }
        return null;
      },
    });
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

    // ─── TCP Dispatcher ────────────────────────────────────────────────
    this.tcpDispatcher.start();

    logger.info("TunnelServer started", {
      wsPort:     this.wsPort,
      tcpPort:    this.tcpPort,
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

      authed = true;

      // สร้าง tunnelId จาก keyId (ใช้ 8 chars แรกของ hash)
      const tunnelId = crypto
        .createHash("sha256")
        .update(result.keyId)
        .digest("hex")
        .slice(0, 8);

      // ─── Replace existing session ────────────────────────────────
      const existing = this.sessions.get(tunnelId);
      if (existing) {
        logger.warn("Replacing session", { tunnelId });
        existing.destroy("reconnected");
      }

      // ─── สร้าง session ────────────────────────────────────────────
      const session = new TunnelSession({
        ws,
        keyId:      result.keyId,
        userId:     result.userId,
        tunnelId,
        plan:       result.plan,
        maxPlayers: result.maxPlayers,
      });

      // จอง UDP port สำหรับ Bedrock
      const udpPort = this.udpDispatcher.allocatePort(result.keyId);
      if (udpPort) {
        session.udpPort = udpPort;
        // ให้ session รู้จัก udpProxy สำหรับส่ง datagram กลับผู้เล่น
        session._udpProxy = this.udpDispatcher.proxies.get(udpPort);
      }

      // TCP ไม่ต้องจอง port แล้ว — ใช้ port 25565 เดียว routing ด้วย tunnelId

      session.on("destroyed", async ({ keyId, userId, rxBytes, txBytes, reason }) => {
        this.sessions.delete(tunnelId);
        this.sessionByKey.delete(keyId);

        if (udpPort) this.udpDispatcher.releasePort(udpPort);

        logger.info("Session ended", { tunnelId, keyId, userId, reason });
        await this.reporter.recordAndFlush(keyId, rxBytes, txBytes);
      });

      session.start();
      session.notifyReady();

      this.sessions.set(tunnelId, session);
      this.sessionByKey.set(result.keyId, session);

      ws.send(JSON.stringify({
        type:     "auth_ok",
        tunnelId,
        hostname: `${tunnelId}.${this.baseDomain}`,
        tcpPort:  this.tcpPort,
        udpPort:  udpPort || null,
        plan:     result.plan,
      }));

      logger.info("Plugin authed", {
        tunnelId,
        hostname: `${tunnelId}.${this.baseDomain}`,
        keyId:    result.keyId,
        userId:   result.userId,
        plan:     result.plan,
        udpPort,
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
        udp:      this.udpDispatcher.stats(),
      }));
      return;
    }

    if (req.url === "/stats") {
      if (req.headers["x-internal-secret"] !== this.webApiSecret) {
        res.writeHead(401); res.end("Unauthorized"); return;
      }
      const sessions = [...this.sessions.values()].map((s) => s.stats());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions, udp: this.udpDispatcher.stats() }));
      return;
    }

    res.writeHead(404); res.end();
  }

  // ─── Stop ──────────────────────────────────────────────────────────
  stop() {
    logger.info("Stopping...");
    for (const s of this.sessions.values()) s.destroy("server_shutdown");
    this.sessions.clear();
    this.tcpDispatcher.stop();
    this.udpDispatcher.stop();
    return new Promise((resolve) => {
      this.reporter.stop().then(() => {
        this.wss.close();
        this.httpServer.close(resolve);
      });
    });
  }
}

module.exports = TunnelServer;
