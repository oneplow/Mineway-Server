"use strict";

const { EventEmitter } = require("events");
const logger = require("./logger");

/**
 * Protocol WebSocket JSON ระหว่าง Tunnel Server <-> Plugin
 *
 * Server → Plugin:
 *   { type:"tunnel_ready",      tunnelId, tcpPort?, udpPort? }
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
  constructor({ ws, keyId, userId, tunnelId, plan, maxPlayers }) {
    super();
    this.ws         = ws;
    this.keyId      = keyId;
    this.userId     = userId;
    this.tunnelId   = tunnelId;   // subdomain เช่น "abc123"
    this.plan       = plan;
    this.maxPlayers = maxPlayers || 0;

    this.tcpPort    = null;   // กำหนดจาก TCPDispatcher (ไม่ใช้ port pool แล้ว)
    this.udpPort    = null;   // กำหนดจาก UDPDispatcher

    // connId -> socket (TCP) หรือ clientAddr string (UDP)
    this.tcpPlayers = new Map(); // connId -> net.Socket
    this.udpClients = new Map(); // connId -> clientAddr string

    this.rxBytes    = BigInt(0);
    this.txBytes    = BigInt(0);
    this.startedAt  = new Date();
    this.alive      = true;

    this._pingTimer   = null;
    this._pingTimeout = null;
  }

  start() {
    // ตั้ง WS handlers
    this.ws.on("message", (raw) => this._onPluginMessage(raw));
    this.ws.on("close",   ()    => this.destroy("ws_closed"));
    this.ws.on("error",   (err) => {
      logger.warn("WS error", { keyId: this.keyId, error: err.message });
      this.destroy("ws_error");
    });

    // ping loop
    this._pingTimer = setInterval(() => this._doPing(), PING_INTERVAL);

    logger.info("Session started", {
      keyId:    this.keyId,
      tunnelId: this.tunnelId,
      userId:   this.userId,
    });

    return true;
  }

  // เรียกหลัง TCPDispatcher และ UDPDispatcher จัดการ port แล้ว
  notifyReady() {
    this._send({
      type:     "tunnel_ready",
      tunnelId: this.tunnelId,
      tcpPort:  this.tcpPort,
      udpPort:  this.udpPort,
    });
  }

  // ─── TCP Player ─────────────────────────────────────────────────────
  // เรียกจาก TCPDispatcher เมื่อผู้เล่นเชื่อมต่อและ handshake ผ่านแล้ว
  addPlayerSocket(sock, handshakeBuf) {
    if (this.maxPlayers > 0 && this.tcpPlayers.size >= this.maxPlayers) {
      this._sendDisconnectToSocket(sock);
      return;
    }

    const connId = randomId();
    this.tcpPlayers.set(connId, sock);

    logger.info("TCP player connected", {
      keyId:   this.keyId,
      connId,
      players: this.tcpPlayers.size,
    });

    // แจ้ง plugin ว่ามี player ใหม่
    this._send({ type: "player_connect", connId, protocol: "tcp" });

    // replay handshake bytes ให้ plugin/MC server ได้รับ
    if (handshakeBuf && handshakeBuf.length > 0) {
      this._send({ type: "player_data", connId, data: handshakeBuf.toString("base64") });
    }

    sock.resume(); // ปลด pause จาก TCPDispatcher

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

  // ─── UDP Player (Bedrock) ────────────────────────────────────────────
  // เรียกจาก UDPDispatcher เมื่อได้รับ datagram
  sendUDPDatagram(clientAddr, data) {
    // หา connId จาก clientAddr หรือสร้างใหม่
    let connId = null;
    for (const [id, addr] of this.udpClients.entries()) {
      if (addr === clientAddr) { connId = id; break; }
    }

    if (!connId) {
      connId = randomId();
      this.udpClients.set(connId, clientAddr);
      this._send({ type: "player_connect", connId, protocol: "udp", clientAddr });
    }

    this.txBytes += BigInt(data.length);
    this._send({ type: "player_data", connId, data: data.toString("base64") });
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
        const udpAddr = this.udpClients.get(msg.connId);
        if (udpAddr && this._udpProxy) {
          this._udpProxy.sendToPlayer(udpAddr, buf);
        }
        break;
      }

      case "mc_disconnect": {
        const tcpSock = this.tcpPlayers.get(msg.connId);
        if (tcpSock) { tcpSock.destroy(); return; }
        // UDP — แค่ลบ record (UDP ไม่มี "close")
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

  _sendDisconnectToSocket(sock) {
    try { sock.destroy(); } catch {}
  }

  // ─── Destroy ─────────────────────────────────────────────────────────
  destroy(reason = "unknown") {
    if (!this.alive) return;
    this.alive = false;

    logger.info("Session destroying", { keyId: this.keyId, reason });

    clearInterval(this._pingTimer);
    clearTimeout(this._pingTimeout);

    for (const sock of this.tcpPlayers.values()) {
      try { sock.destroy(); } catch {}
    }
    this.tcpPlayers.clear();
    this.udpClients.clear();

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
      keyId:      this.keyId,
      tunnelId:   this.tunnelId,
      userId:     this.userId,
      tcpPlayers: this.tcpPlayers.size,
      udpClients: this.udpClients.size,
      rxBytes:    this.rxBytes.toString(),
      txBytes:    this.txBytes.toString(),
      uptime:     Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = TunnelSession;
