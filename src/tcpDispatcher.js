"use strict";

const net    = require("net");
const logger = require("./logger");
const { parseHandshake, extractTunnelId, MAX_HANDSHAKE_BYTES } = require("./mcHandshake");

/**
 * TCPDispatcher
 *
 * เปิด TCP port เดียว (default 25565) รับ Java Edition players ทุกคน
 * อ่าน MC Handshake packet แรก → ดู hostname → หา TunnelSession → forward
 *
 * สำคัญ: หลังจากหา session ได้แล้ว ต้อง "replay" handshake packet กลับไปด้วย
 * เพราะ plugin/MC server ยังไม่ได้เห็น packet นั้น
 */
class TCPDispatcher {
  /**
   * @param {object} opts
   * @param {number} opts.port — TCP port ที่รับผู้เล่น (default 25565)
   * @param {string} opts.baseDomain — เช่น "mctunnel.io"
   * @param {function} opts.findSession — (tunnelId: string) => TunnelSession | null
   */
  constructor({ port, baseDomain, findSession }) {
    this.port        = port || 25565;
    this.baseDomain  = baseDomain;
    this.findSession = findSession;
    this.server      = null;
  }

  start() {
    this.server = net.createServer((sock) => this._onConnection(sock));

    this.server.on("error", (err) => {
      logger.error("TCPDispatcher error", { error: err.message });
    });

    this.server.listen(this.port, "0.0.0.0", () => {
      logger.info("TCPDispatcher listening", {
        port:       this.port,
        baseDomain: this.baseDomain,
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  // ─── Handle new player connection ─────────────────────────────────
  _onConnection(sock) {
    const remote = `${sock.remoteAddress}:${sock.remotePort}`;
    logger.debug("Player TCP connected", { remote });

    // รวม chunks จนกว่าจะ parse handshake ได้
    const chunks = [];
    let totalLen = 0;

    const onData = (chunk) => {
      chunks.push(chunk);
      totalLen += chunk.length;

      const buf = Buffer.concat(chunks);

      // ลอง parse
      const hs = parseHandshake(buf);

      if (hs) {
        // parse ได้แล้ว หยุดรับ data event ชั่วคราว
        sock.removeListener("data", onData);
        sock.pause();

        this._route(sock, buf, hs, remote);
        return;
      }

      // ข้อมูลยังไม่พอ รอต่อ แต่ถ้าเกิน MAX ให้ตัดทิ้ง
      if (totalLen > MAX_HANDSHAKE_BYTES) {
        logger.warn("Handshake too large, dropping", { remote, bytes: totalLen });
        sock.destroy();
      }
    };

    sock.on("data", onData);

    sock.on("error", (err) => {
      logger.debug("Player socket error (pre-route)", { remote, error: err.message });
    });

    // timeout ถ้าไม่ส่ง handshake ใน 5 วินาที
    sock.setTimeout(5000, () => {
      logger.warn("Handshake timeout", { remote });
      sock.destroy();
    });
  }

  // ─── Route to correct tunnel session ──────────────────────────────
  _route(sock, fullBuf, hs, remote) {
    // reset timeout หลังจาก handshake ผ่านแล้ว
    sock.setTimeout(0);

    const tunnelId = extractTunnelId(hs.hostname, this.baseDomain);

    logger.info("Routing player", {
      remote,
      hostname:   hs.hostname,
      tunnelId,
      nextState:  hs.nextState,
      protocol:   hs.protocolVersion,
    });

    if (!tunnelId) {
      logger.warn("Cannot extract tunnelId from hostname", { hostname: hs.hostname });
      sock.destroy();
      return;
    }

    const session = this.findSession(tunnelId);

    if (!session) {
      logger.warn("No active tunnel for id", { tunnelId });
      // ส่ง disconnect message กลับไปให้ผู้เล่น (MC format)
      this._sendDisconnect(sock, `§cเซิร์ฟนี้ไม่ได้ออนไลน์อยู่`);
      return;
    }

    // ─── Forward connection ไปยัง session ──────────────────────────
    // ส่ง handshake buffer ทั้งหมด (รวม bytes ที่ยังค้างอยู่) ให้ session จัดการต่อ
    session.addPlayerSocket(sock, fullBuf);

    logger.info("Player routed", { tunnelId, remote });
  }

  // ─── Send MC disconnect packet ─────────────────────────────────────
  // ใช้ตอนที่ tunnel ไม่ online — ส่ง JSON text ให้ผู้เล่นเห็นข้อความ
  _sendDisconnect(sock, message) {
    try {
      // Login Disconnect packet (0x00 in login state)
      const json    = JSON.stringify({ text: message });
      const jsonBuf = Buffer.from(json, "utf8");

      // VarInt encode string length
      const strLen  = encodeVarInt(jsonBuf.length);
      // packet id 0x00
      const pktId   = Buffer.from([0x00]);
      // packet data
      const data    = Buffer.concat([pktId, strLen, jsonBuf]);
      // packet length
      const pktLen  = encodeVarInt(data.length);

      sock.write(Buffer.concat([pktLen, data]));
    } catch {}
    sock.destroy();
  }
}

// ─── VarInt encoder ─────────────────────────────────────────────────
function encodeVarInt(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

module.exports = TCPDispatcher;
