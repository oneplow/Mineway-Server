"use strict";

/**
 * Minecraft Java Edition — Handshake Packet Parser
 *
 * packet format (uncompressed, unencrypted — ก่อน login):
 *   [VarInt: packet length]
 *   [VarInt: packet id = 0x00]
 *   [VarInt: protocol version]
 *   [String: server address]   ← เราต้องการตรงนี้
 *   [UShort: server port]
 *   [VarInt: next state]
 *
 * String format: [VarInt: byte length][UTF-8 bytes]
 *
 * อ่านแค่ bytes แรกที่จำเป็น ไม่ต้องรอ full packet
 */

const MAX_HANDSHAKE_BYTES = 512; // handshake จริงๆ ไม่เกิน 256 bytes

/**
 * อ่าน VarInt จาก Buffer ณ offset ที่กำหนด
 * @returns {{ value: number, bytesRead: number }} หรือ null ถ้าข้อมูลไม่พอ
 */
function readVarInt(buf, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;

  while (i < buf.length) {
    const byte = buf[i++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      return { value, bytesRead: i - offset };
    }
    if (shift >= 35) return null; // VarInt ยาวเกินไป
  }

  return null; // ข้อมูลไม่พอ
}

/**
 * อ่าน String (VarInt length + UTF-8) จาก Buffer
 * @returns {{ value: string, bytesRead: number }} หรือ null
 */
function readString(buf, offset) {
  const lenResult = readVarInt(buf, offset);
  if (!lenResult) return null;

  const strStart = offset + lenResult.bytesRead;
  const strEnd   = strStart + lenResult.value;

  if (strEnd > buf.length) return null;

  return {
    value:     buf.slice(strStart, strEnd).toString("utf8"),
    bytesRead: lenResult.bytesRead + lenResult.value,
  };
}

/**
 * Parse MC Java handshake packet
 *
 * @param {Buffer} data — raw bytes ที่ได้จาก socket
 * @returns {{
 *   hostname: string,     — server address ที่ผู้เล่นพิมพ์
 *   port: number,
 *   protocolVersion: number,
 *   nextState: number,    — 1 = status ping, 2 = login
 *   packetLength: number  — จำนวน bytes ทั้งหมดของ handshake packet
 * }} หรือ null ถ้า parse ไม่ได้
 */
function parseHandshake(data) {
  if (!data || data.length < 5) return null;

  let offset = 0;

  // packet length
  const pktLen = readVarInt(data, offset);
  if (!pktLen) return null;
  offset += pktLen.bytesRead;

  // packet id (ต้องเป็น 0x00)
  const pktId = readVarInt(data, offset);
  if (!pktId || pktId.value !== 0x00) return null;
  offset += pktId.bytesRead;

  // protocol version
  const proto = readVarInt(data, offset);
  if (!proto) return null;
  offset += proto.bytesRead;

  // server address (hostname ที่ผู้เล่นพิมพ์)
  const addr = readString(data, offset);
  if (!addr) return null;
  offset += addr.bytesRead;

  // server port (2 bytes big-endian)
  if (offset + 2 > data.length) return null;
  const port = data.readUInt16BE(offset);
  offset += 2;

  // next state
  const nextState = readVarInt(data, offset);
  if (!nextState) return null;

  // แยก hostname จริงออกจาก FML marker เช่น "abc.mctunnel.io\x00FML2\x00"
  // Forge ต่อ \x00 ไว้หลัง hostname
  let hostname = addr.value.split("\x00")[0].toLowerCase().trim();

  return {
    hostname,
    port,
    protocolVersion: proto.value,
    nextState:       nextState.value,
    packetLength:    pktLen.bytesRead + pktLen.value,
  };
}

/**
 * Extract subdomain จาก hostname
 * เช่น "abc123.play.mctunnel.io" → "abc123"
 *      "abc123.mctunnel.io"      → "abc123"
 */
function extractTunnelId(hostname, baseDomain) {
  const base = baseDomain.toLowerCase();

  // ลบ base domain ออก
  if (!hostname.endsWith("." + base) && hostname !== base) {
    return null;
  }

  const sub = hostname.slice(0, hostname.length - base.length - 1);
  if (!sub) return null;

  // ถ้า subdomain มีหลายชั้น เช่น "abc123.play" → เอาแค่ "abc123"
  return sub.split(".")[0];
}

module.exports = { parseHandshake, extractTunnelId, MAX_HANDSHAKE_BYTES };
