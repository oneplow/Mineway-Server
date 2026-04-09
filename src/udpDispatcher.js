"use strict";

const dgram  = require("dgram");
const logger = require("./logger");

/**
 * UDPDispatcher — Bedrock Edition (RakNet protocol)
 *
 * Bedrock ใช้ UDP + RakNet ซึ่งซับซ้อนกว่า TCP มาก
 * วิธีที่ practical ที่สุดคือ:
 *   1. เปิด UDP port เดียว (19132) รับทุก datagram
 *   2. แยก "virtual connection" ด้วย src IP:port (RakNet session)
 *   3. อ่าน RakNet Unconnected Ping (packet 0x01) เพื่อดู tunnelId
 *      — Bedrock ส่ง custom data ใน ping ที่เราใส่ tunnelId ไว้ได้
 *   4. Map src addr → tunnel session แล้ว forward UDP datagrams
 *
 * สำหรับ Bedrock: ผู้เล่นต้องเชื่อมที่ IP:19132 แต่เราแยก tunnel
 * ด้วย "virtual host" — ใช้ IP ของ VPS ต่างกัน หรือใช้ port ต่างกัน
 * (Bedrock ไม่มี hostname ใน handshake เหมือน Java)
 *
 * DESIGN ที่เลือกใช้:
 *   - แต่ละ Bedrock tunnel จะได้ port ของตัวเองในช่วง 19200-19999
 *   - ผู้เล่นเชื่อมที่ VPS_IP:PORT_ของ_tunnel_นั้น
 *   - port จะแสดงใน dashboard เหมือน Java แต่เป็น UDP
 *
 * ทำไมไม่ใช้ single port เหมือน Java?
 *   Java มี hostname ใน handshake → routing ง่าย
 *   Bedrock/RakNet ไม่มี hostname concept → ต้องใช้ port แยก หรือ IP แยก
 */
class UDPDispatcher {
  /**
   * @param {object} opts
   * @param {function} opts.findSessionByPort — (port: number) => TunnelSession | null
   */
  constructor({ findSessionByPort }) {
    this.findSessionByPort = findSessionByPort;

    // port -> UDPTunnelProxy
    this.proxies = new Map();

    // UDP port pool สำหรับ Bedrock (แยกจาก TCP)
    const start = parseInt(process.env.BEDROCK_PORT_START || "19200");
    const end   = parseInt(process.env.BEDROCK_PORT_END   || "19999");
    this.portPool = [];
    for (let p = start; p <= end; p++) this.portPool.push(p);

    logger.info("UDPDispatcher ready", {
      bedrockPorts: `${start}-${end}`,
      total: this.portPool.length,
    });
  }

  // จอง UDP port ให้ Bedrock tunnel
  allocatePort(keyId) {
    if (this.portPool.length === 0) return null;
    const port = this.portPool.shift();

    const proxy = new UDPTunnelProxy({ port, keyId, findSession: this.findSessionByPort });
    proxy.start();
    this.proxies.set(port, proxy);

    return port;
  }

  releasePort(port) {
    const proxy = this.proxies.get(port);
    if (proxy) {
      proxy.stop();
      this.proxies.delete(port);
      this.portPool.unshift(port);
    }
  }

  stop() {
    for (const proxy of this.proxies.values()) proxy.stop();
    this.proxies.clear();
  }

  stats() {
    return {
      used:  this.proxies.size,
      free:  this.portPool.length,
      total: this.proxies.size + this.portPool.length,
    };
  }
}

/**
 * UDPTunnelProxy — UDP proxy สำหรับ 1 Bedrock tunnel
 *
 * รับ datagram จาก Bedrock players → ส่งผ่าน WebSocket ไปหา plugin
 * รับ datagram กลับจาก plugin → ส่งกลับไปหา player
 *
 * แต่ละ src addr ถือเป็น 1 "virtual connection"
 */
class UDPTunnelProxy {
  constructor({ port, keyId, findSession }) {
    this.port        = port;
    this.keyId       = keyId;
    this.findSession = findSession;
    this.socket      = null;

    // clientAddr (string) -> { lastSeen, rxBytes, txBytes }
    this.clients = new Map();

    // cleanup clients ที่ไม่ active นาน 5 นาที
    this._cleanupTimer = setInterval(() => this._cleanupClients(), 60_000);
    this._cleanupTimer.unref();
  }

  start() {
    this.socket = dgram.createSocket("udp4");

    this.socket.on("message", (msg, rinfo) => {
      this._onPlayerDatagram(msg, rinfo);
    });

    this.socket.on("error", (err) => {
      logger.error("UDP proxy error", { port: this.port, keyId: this.keyId, error: err.message });
    });

    this.socket.bind(this.port, "0.0.0.0", () => {
      logger.info("UDP proxy listening", { port: this.port, keyId: this.keyId });
    });
  }

  stop() {
    clearInterval(this._cleanupTimer);
    if (this.socket) {
      try { this.socket.close(); } catch {}
    }
  }

  _onPlayerDatagram(msg, rinfo) {
    const clientAddr = `${rinfo.address}:${rinfo.port}`;

    // อัปเดต client record
    const client = this.clients.get(clientAddr) || { lastSeen: 0, rxBytes: 0, txBytes: 0 };
    client.lastSeen = Date.now();
    client.txBytes += msg.length;
    this.clients.set(clientAddr, client);

    // หา session แล้วส่ง datagram ผ่าน WebSocket
    const session = this.findSession(this.port);
    if (!session || !session.alive) return;

    session.sendUDPDatagram(clientAddr, msg);
  }

  // เรียกจาก session เมื่อ plugin ส่ง datagram กลับมา
  sendToPlayer(clientAddr, data) {
    const [ip, portStr] = clientAddr.rsplit ? clientAddr.rsplit(":", 1) : clientAddr.split(":").reduce((a, p, i, arr) => i < arr.length - 1 ? [a[0] + (a[0] ? ":" : "") + p, arr[arr.length - 1]] : a, ["", ""]);
    const port = parseInt(portStr);

    if (!this.socket) return;

    this.socket.send(data, port, ip, (err) => {
      if (err) logger.debug("UDP send error", { clientAddr, error: err.message });
    });

    const client = this.clients.get(clientAddr);
    if (client) client.rxBytes += data.length;
  }

  _cleanupClients() {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [addr, c] of this.clients.entries()) {
      if (c.lastSeen < cutoff) this.clients.delete(addr);
    }
  }
}

module.exports = UDPDispatcher;
