"use strict";

const crypto = require("crypto");
const logger = require("../lib/logger");
const { verifyKey } = require("../lib/keyVerifier");
const TunnelSession = require("../lib/session");

/**
 * WebSocket Controller — จัดการการเชื่อมต่อ Plugin → Tunnel Server
 *
 * Flow:
 * 1. Plugin เชื่อมต่อ WebSocket
 * 2. Plugin ส่ง { type: "auth", key: "mw_..." }
 * 3. Server ตรวจสอบกับ Web API
 * 4. ถ้าผ่าน → สร้าง TunnelSession → bind TCP/UDP port
 * 5. ถ้าไม่ผ่าน → ปิดการเชื่อมต่อ
 */

const AUTH_TIMEOUT_MS = 10_000; // 10 seconds to authenticate

function createWsHandler({ sessions, reporter, webApiUrl, nodeToken, baseDomain }) {
  return function handleConnection(ws, req) {
    const ip = req.socket.remoteAddress;
    let authed = false;

    // Auto-close if plugin doesn't authenticate in time
    const timeout = setTimeout(() => {
      if (!authed) {
        logger.warn("Auth timeout", { ip });
        ws.close(4001, "auth_timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.once("message", async (raw) => {
      clearTimeout(timeout);

      // ── Parse message ───────────────────────────────────
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        ws.close(4002, "invalid_json");
        return;
      }

      if (msg.type !== "auth" || !msg.key) {
        ws.close(4003, "expected_auth");
        return;
      }

      // ── Verify key with Web API ─────────────────────────
      const result = await verifyKey(msg.key, { webApiUrl, nodeToken });

      if (!result.valid) {
        ws.send(JSON.stringify({ type: "auth_failed", reason: result.reason }));
        ws.close(4004, result.reason);
        return;
      }

      authed = true;
      const tunnelId = crypto.createHash("sha256").update(result.keyId).digest("hex").slice(0, 8);

      // ── Kick existing session for same key (reconnect) ──
      if (sessions.has(result.keyId)) {
        logger.info("Replacing existing session", { keyId: result.keyId });
        sessions.get(result.keyId).destroy("reconnected");
      }

      // ── Create session ──────────────────────────────────
      const session = new TunnelSession({
        ws,
        tunnelId,
        keyId:        result.keyId,
        userId:       result.userId,
        assignedPort: result.assignedPort,
        plan:         result.plan,
        maxPlayers:   result.maxPlayers,
      });

      session.on("destroyed", async ({ keyId, rxBytes, txBytes }) => {
        sessions.delete(keyId);
        await reporter.recordAndFlush(keyId, rxBytes, txBytes);
      });

      // ── Start tunnel (bind TCP/UDP) ─────────────────────
      const ok = await session.start();
      if (!ok) {
        ws.send(JSON.stringify({ type: "auth_failed", reason: "port_bind_failed" }));
        ws.close(4006, "port_bind_failed");
        return;
      }

      sessions.set(result.keyId, session);

      // ── Confirm to plugin ───────────────────────────────
      ws.send(JSON.stringify({
        type: "auth_ok",
        tunnelId,
        hostname:     result.subdomain || baseDomain,
        tcpPort:      result.assignedPort,
        udpPort:      result.assignedPort,
        isCustomPort: result.isCustomPort || false,
        plan:         result.plan,
      }));

      logger.info("Plugin authed", { tunnelId, port: result.assignedPort, ip });
    });
  };
}

module.exports = { createWsHandler };
