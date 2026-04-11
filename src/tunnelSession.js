"use strict";

const { EventEmitter } = require("events");
const net    = require("net");
const dgram  = require("dgram");
const logger = require("./logger");

/**
 * TunnelSession — Port Allocation Edition
 *
 * แต่ละ session จะเปิด TCP server + UDP socket บน assignedPort เดียวกัน
 * รับผู้เล่นทั้ง Java (TCP) และ Bedrock (UDP) ได้พร้อมกัน
 *
 * Protocol WebSocket JSON ระหว่าง Tunnel Server <-> Plugin:
 *
 * Server → Plugin:
 *   { type:"tunnel_ready",      tunnelId, tcpPort, udpPort }
 *   { type:"player_connect",    connId, protocol }   protocol: "tcp"|"udp"
 *   { type:"player_data",       connId, data }        data: base64
 *   { type:"player_disconnect", connId }
 *   { type:"ping" }
 *
 * Plugin → Server:
 *   { type:"auth",          key }
 *   { type:"mc_data",       connId, data }            data: base64
 *   { type:"mc_disconnect", connId }
 *   { type:"pong" }
 */

const PING_INTERVAL = 30_000;
const PING_TIMEOUT  = 10_000;

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

    // connId -> net.Socket (TCP players)
    this.tcpPlayers = new Map();
    // connId -> { addr: string, port: number } (UDP/Bedrock clients)
    this.udpClients = new Map();

    // Owned sockets
    this._tcpServer = null;
    this._udpSocket = null;

    this.rxBytes    = BigInt(0);
    this.txBytes    = BigInt(0);
    this.startedAt  = new Date();
    this.alive      = true;

    this._pingTimer   = null;
    this._pingTimeout = null;

    // cleanup idle UDP clients every 60s
    this._udpCleanupTimer = setInterval(() => this._cleanupUdpClients(), 60_000);
    this._udpCleanupTimer.unref();
  }

  /**
   * Start listening on assignedPort for both TCP and UDP.
   * @returns {Promise<boolean>} true if both binds succeeded
   */
  async start() {
    // ตั้ง WS handlers
    this.ws.on("message", (raw) => this._onPluginMessage(raw));
    this.ws.on("close",   ()    => this.destroy("ws_closed"));
    this.ws.on("error",   (err) => {
      logger.warn("WS error", { keyId: this.keyId, error: err.message });
      this.destroy("ws_error");
    });

    try {
      await Promise.all([
        this._startTCP(),
        this._startUDP(),
      ]);
    } catch (err) {
      logger.error("Port bind failed", {
        keyId: this.keyId,
        port: this.assignedPort,
        error: err.message,
      });
      this.destroy("bind_failed");
      return false;
    }

    // ping loop
    this._pingTimer = setInterval(() => this._doPing(), PING_INTERVAL);

    logger.info("Session started", {
      keyId:        this.keyId,
      tunnelId:     this.tunnelId,
      assignedPort: this.assignedPort,
    });

    // แจ้ง plugin ว่า tunnel พร้อม
    this._send({
      type:     "tunnel_ready",
      tunnelId: this.tunnelId,
      tcpPort:  this.assignedPort,
      udpPort:  this.assignedPort,
    });

    return true;
  }

  // ─── TCP server (Java Edition) ──────────────────────────────────────
  _startTCP() {
    return new Promise((resolve, reject) => {
      this._tcpServer = net.createServer((sock) => this._onTCPConnection(sock));

      this._tcpServer.on("error", (err) => {
        if (!this.alive) return;
        logger.error("TCP server error", { keyId: this.keyId, port: this.assignedPort, error: err.message });
      });

      this._tcpServer.listen(this.assignedPort, "0.0.0.0", () => {
        logger.info("TCP listening", { keyId: this.keyId, port: this.assignedPort });
        resolve();
      });

      this._tcpServer.once("error", reject);
    });
  }

  _onTCPConnection(sock) {
    if (this.maxPlayers > 0 && this.tcpPlayers.size >= this.maxPlayers) {
      sock.destroy();
      return;
    }

    const connId = randomId();
    this.tcpPlayers.set(connId, sock);

    const remote = `${sock.remoteAddress}:${sock.remotePort}`;
    logger.info("TCP player connected", { keyId: this.keyId, connId, remote, players: this.tcpPlayers.size });

    // แจ้ง plugin ว่ามี player ใหม่
    this._send({ type: "player_connect", connId, protocol: "tcp" });

    sock.on("data", (chunk) => {
      this.txBytes += BigInt(chunk.length);
      this._send({ type: "player_data", connId, data: chunk.toString("base64") });
    });

    sock.on("close", () => {
      this.tcpPlayers.delete(connId);
      logger.info("TCP player disconnected", { keyId: this.keyId, connId });
      this._send({ type: "player_disconnect", connId });
    });

    sock.on("error", (err) => {
      logger.debug("TCP player socket error", { connId, error: err.message });
      sock.destroy();
    });
  }

  // ─── UDP socket (Bedrock/RakNet) ────────────────────────────────────
  _startUDP() {
    return new Promise((resolve, reject) => {
      this._udpSocket = dgram.createSocket("udp4");

      this._udpSocket.on("message", (msg, rinfo) => {
        this._onUDPDatagram(msg, rinfo);
      });

      this._udpSocket.on("error", (err) => {
        if (!this.alive) return;
        logger.error("UDP socket error", { keyId: this.keyId, port: this.assignedPort, error: err.message });
      });

      this._udpSocket.bind(this.assignedPort, "0.0.0.0", () => {
        logger.info("UDP listening", { keyId: this.keyId, port: this.assignedPort });
        resolve();
      });

      this._udpSocket.once("error", reject);
    });
  }

  _onUDPDatagram(msg, rinfo) {
    const clientAddr = `${rinfo.address}:${rinfo.port}`;

    // หา connId จาก clientAddr หรือสร้างใหม่
    let connId = null;
    for (const [id, client] of this.udpClients.entries()) {
      if (client.addr === rinfo.address && client.port === rinfo.port) {
        connId = id;
        client.lastSeen = Date.now();
        break;
      }
    }

    if (!connId) {
      connId = randomId();
      this.udpClients.set(connId, {
        addr: rinfo.address,
        port: rinfo.port,
        lastSeen: Date.now(),
      });
      this._send({ type: "player_connect", connId, protocol: "udp", clientAddr });
    }

    this.txBytes += BigInt(msg.length);
    this._send({ type: "player_data", connId, data: msg.toString("base64") });
  }

  _sendUDPToPlayer(clientAddr, data) {
    if (!this._udpSocket) return;

    // parse "ip:port"
    const lastColon = clientAddr.lastIndexOf(":");
    const ip   = clientAddr.slice(0, lastColon);
    const port = parseInt(clientAddr.slice(lastColon + 1));

    this._udpSocket.send(data, port, ip, (err) => {
      if (err) logger.debug("UDP send error", { clientAddr, error: err.message });
    });
  }

  _cleanupUdpClients() {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [connId, client] of this.udpClients.entries()) {
      if (client.lastSeen < cutoff) {
        this.udpClients.delete(connId);
        this._send({ type: "player_disconnect", connId });
      }
    }
  }

  // ─── Plugin message ──────────────────────────────────────────────────
  _onPluginMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    switch (msg.type) {
      case "mc_data": {
        const buf = Buffer.from(msg.data, "base64");
        this.rxBytes += BigInt(buf.length);

        // ลอง TCP ก่อน
        const tcpSock = this.tcpPlayers.get(msg.connId);
        if (tcpSock && !tcpSock.destroyed) {
          tcpSock.write(buf);
          return;
        }

        // ลอง UDP
        const udpClient = this.udpClients.get(msg.connId);
        if (udpClient) {
          this._sendUDPToPlayer(`${udpClient.addr}:${udpClient.port}`, buf);
        }
        break;
      }

      case "mc_disconnect": {
        const tcpSock = this.tcpPlayers.get(msg.connId);
        if (tcpSock) { tcpSock.destroy(); return; }
        // UDP — แค่ลบ record
        this.udpClients.delete(msg.connId);
        break;
      }

      case "pong":
        clearTimeout(this._pingTimeout);
        this._pingTimeout = null;
        break;
    }
  }

  // ─── Ping ────────────────────────────────────────────────────────────
  _doPing() {
    if (!this.alive) return;
    this._send({ type: "ping" });
    this._pingTimeout = setTimeout(() => {
      logger.warn("Plugin ping timeout", { keyId: this.keyId });
      this.destroy("ping_timeout");
    }, PING_TIMEOUT);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────
  _send(obj) {
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ─── Destroy ─────────────────────────────────────────────────────────
  destroy(reason = "unknown") {
    if (!this.alive) return;
    this.alive = false;

    logger.info("Session destroying", { keyId: this.keyId, port: this.assignedPort, reason });

    clearInterval(this._pingTimer);
    clearTimeout(this._pingTimeout);
    clearInterval(this._udpCleanupTimer);

    // close all TCP player sockets
    for (const sock of this.tcpPlayers.values()) {
      try { sock.destroy(); } catch {}
    }
    this.tcpPlayers.clear();
    this.udpClients.clear();

    // close TCP server
    if (this._tcpServer) {
      try { this._tcpServer.close(); } catch {}
      this._tcpServer = null;
    }

    // close UDP socket
    if (this._udpSocket) {
      try { this._udpSocket.close(); } catch {}
      this._udpSocket = null;
    }

    try { this.ws.close(1000, reason); } catch {}

    this.emit("destroyed", {
      keyId:   this.keyId,
      userId:  this.userId,
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      reason,
    });
  }

  stats() {
    return {
      keyId:        this.keyId,
      tunnelId:     this.tunnelId,
      userId:       this.userId,
      assignedPort: this.assignedPort,
      tcpPlayers:   this.tcpPlayers.size,
      udpClients:   this.udpClients.size,
      rxBytes:      this.rxBytes.toString(),
      txBytes:      this.txBytes.toString(),
      uptime:       Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = TunnelSession;
