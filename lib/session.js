"use strict";

const { EventEmitter } = require("events");
const net    = require("net");
const dgram  = require("dgram");
const logger = require("./logger");

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * TunnelSession — 1 API Key = 1 Port = 1 Session
 *
 * เปิด TCP server + UDP socket บน assignedPort เดียวกัน
 * รับ Minecraft ทั้ง Java (TCP) และ Bedrock (UDP) พร้อมกัน
 */
class TunnelSession extends EventEmitter {
  constructor({ ws, keyId, userId, tunnelId, assignedPort, plan, maxPlayers }) {
    super();
    this.ws           = ws;
    this.keyId        = keyId;
    this.userId       = userId;
    this.tunnelId     = tunnelId;
    this.assignedPort = assignedPort;
    this.plan         = plan;
    this.maxPlayers   = maxPlayers || 0;

    this.tcpPlayers = new Map(); // connId -> net.Socket
    this.udpClients = new Map(); // connId -> { addr, port, lastSeen }
    this._tcpServer = null;
    this._udpSocket = null;

    this.rxBytes  = BigInt(0);
    this.txBytes  = BigInt(0);
    this.startedAt = new Date();
    this.alive     = true;

    this._pingTimeout = null;
    this._pingTimer   = null;
    this._udpCleanup  = null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async start() {
    this.ws.on("message", (raw) => this._onPluginMessage(raw));
    this.ws.on("close",   ()    => this.destroy("ws_closed"));
    this.ws.on("error",   ()    => this.destroy("ws_error"));

    try {
      await Promise.all([this._bindTCP(), this._bindUDP()]);
    } catch (err) {
      logger.error("Port bind failed", { keyId: this.keyId, port: this.assignedPort, error: err.message });
      this.destroy("bind_failed");
      return false;
    }

    this._pingTimer  = setInterval(() => this._doPing(), 30_000);
    this._udpCleanup = setInterval(() => this._cleanupUdp(), 60_000);
    this._udpCleanup.unref();

    logger.info("Session started", { keyId: this.keyId, tunnelId: this.tunnelId, port: this.assignedPort });

    this._send({
      type:     "tunnel_ready",
      tunnelId: this.tunnelId,
      tcpPort:  this.assignedPort,
      udpPort:  this.assignedPort,
    });

    return true;
  }

  destroy(reason = "unknown") {
    if (!this.alive) return;
    this.alive = false;

    logger.info("Session destroying", { keyId: this.keyId, port: this.assignedPort, reason });

    clearInterval(this._pingTimer);
    clearTimeout(this._pingTimeout);
    clearInterval(this._udpCleanup);

    for (const sock of this.tcpPlayers.values()) { try { sock.destroy(); } catch {} }
    this.tcpPlayers.clear();
    this.udpClients.clear();

    if (this._tcpServer) { try { this._tcpServer.close(); } catch {} }
    if (this._udpSocket) { try { this._udpSocket.close(); } catch {} }

    try { 
      if (this.ws.readyState === 1 /* OPEN */) {
        this.ws.send(JSON.stringify({ type: "auth_failed", reason }));
      }
      this.ws.close(4004, reason); 
    } catch {}

    this.emit("destroyed", {
      keyId:   this.keyId,
      userId:  this.userId,
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      reason,
    });
  }

  // ─── Suspend / Resume (keeps WS alive) ───────────────────────────────

  suspend() {
    if (!this.alive || this.suspended) return;
    this.suspended = true;

    logger.info("Session suspended", { keyId: this.keyId, port: this.assignedPort });

    // Kick all connected players
    for (const sock of this.tcpPlayers.values()) { try { sock.destroy(); } catch {} }
    this.tcpPlayers.clear();
    this.udpClients.clear();

    // Close TCP/UDP listeners so no new players can join
    if (this._tcpServer) { try { this._tcpServer.close(); } catch {} this._tcpServer = null; }
    if (this._udpSocket) { try { this._udpSocket.close(); } catch {} this._udpSocket = null; }

    // Notify plugin
    this._send({ type: "suspended" });
  }

  async resume() {
    if (!this.alive || !this.suspended) return false;

    logger.info("Session resuming", { keyId: this.keyId, port: this.assignedPort });

    // Re-bind TCP/UDP
    try {
      await Promise.all([this._bindTCP(), this._bindUDP()]);
    } catch (err) {
      logger.error("Port re-bind failed on resume", { keyId: this.keyId, port: this.assignedPort, error: err.message });
      return false;
    }

    this.suspended = false;

    // Notify plugin
    this._send({
      type: "resumed",
      tunnelId: this.tunnelId,
      tcpPort: this.assignedPort,
      udpPort: this.assignedPort,
    });

    return true;
  }

  // ─── TCP (Java Edition) ───────────────────────────────────────────────

  _bindTCP() {
    return new Promise((resolve, reject) => {
      this._tcpServer = net.createServer((sock) => this._onTCP(sock));
      this._tcpServer.once("error", reject);
      this._tcpServer.listen(this.assignedPort, "0.0.0.0", resolve);
    });
  }

  _onTCP(sock) {
    if (this.maxPlayers > 0 && this.tcpPlayers.size >= this.maxPlayers) {
      sock.destroy();
      return;
    }

    const connId = randomId();
    this.tcpPlayers.set(connId, sock);
    logger.info("TCP player +", { connId, remote: `${sock.remoteAddress}:${sock.remotePort}` });

    this._send({ type: "player_connect", connId, protocol: "tcp" });

    sock.on("data", (chunk) => {
      this.txBytes += BigInt(chunk.length);
      this._send({ type: "player_data", connId, data: chunk.toString("base64") });
    });

    sock.on("close", () => {
      this.tcpPlayers.delete(connId);
      this._send({ type: "player_disconnect", connId });
    });

    sock.on("error", () => sock.destroy());
  }

  // ─── UDP (Bedrock / RakNet) ───────────────────────────────────────────

  _bindUDP() {
    return new Promise((resolve, reject) => {
      this._udpSocket = dgram.createSocket("udp4");
      this._udpSocket.on("message", (msg, rinfo) => this._onUDP(msg, rinfo));
      this._udpSocket.once("error", reject);
      this._udpSocket.bind(this.assignedPort, "0.0.0.0", resolve);
    });
  }

  _onUDP(msg, rinfo) {
    let connId = null;
    for (const [id, c] of this.udpClients.entries()) {
      if (c.addr === rinfo.address && c.port === rinfo.port) {
        connId = id;
        c.lastSeen = Date.now();
        break;
      }
    }

    if (!connId) {
      connId = randomId();
      this.udpClients.set(connId, { addr: rinfo.address, port: rinfo.port, lastSeen: Date.now() });
      this._send({ type: "player_connect", connId, protocol: "udp", clientAddr: `${rinfo.address}:${rinfo.port}` });
    }

    this.txBytes += BigInt(msg.length);
    this._send({ type: "player_data", connId, data: msg.toString("base64") });
  }

  _cleanupUdp() {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [connId, c] of this.udpClients.entries()) {
      if (c.lastSeen < cutoff) {
        this.udpClients.delete(connId);
        this._send({ type: "player_disconnect", connId });
      }
    }
  }

  // ─── Plugin → Server messages ─────────────────────────────────────────

  _onPluginMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "mc_data": {
        const buf = Buffer.from(msg.data, "base64");
        this.rxBytes += BigInt(buf.length);

        const tcpSock = this.tcpPlayers.get(msg.connId);
        if (tcpSock && !tcpSock.destroyed) { tcpSock.write(buf); return; }

        const udp = this.udpClients.get(msg.connId);
        if (udp && this._udpSocket) {
          this._udpSocket.send(buf, udp.port, udp.addr);
        }
        break;
      }
      case "mc_disconnect": {
        const s = this.tcpPlayers.get(msg.connId);
        if (s) s.destroy();
        else this.udpClients.delete(msg.connId);
        break;
      }
      case "pong":
        clearTimeout(this._pingTimeout);
        this._pingTimeout = null;
        break;
    }
  }

  // ─── Ping ─────────────────────────────────────────────────────────────

  _doPing() {
    if (!this.alive) return;
    this._send({ type: "ping" });
    this._pingTimeout = setTimeout(() => this.destroy("ping_timeout"), 10_000);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  _send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  stats() {
    return {
      keyId:        this.keyId,
      tunnelId:     this.tunnelId,
      assignedPort: this.assignedPort,
      tcpPlayers:   this.tcpPlayers.size,
      udpClients:   this.udpClients.size,
      rxBytes:      this.rxBytes.toString(),
      txBytes:      this.txBytes.toString(),
      uptime:       Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}

module.exports = TunnelSession;
