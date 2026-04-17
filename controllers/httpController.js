"use strict";

const logger = require("../lib/logger");

/**
 * HTTP Controller — จัดการ REST API ภายใน Tunnel Server
 * 
 * Endpoints:
 * - GET  /health          → Health check (public)
 * - GET  /stats           → Session stats (protected)
 * - POST /kick/:keyId     → Force disconnect a session (protected)
 * - POST /suspend/:keyId  → Suspend a session (protected)
 * - POST /resume/:keyId   → Resume a suspended session (protected)
 */

function json(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function isAuthorized(req, token) {
  return req.headers["x-node-token"] === token;
}

function createHttpHandler(sessions, nodeToken) {
  return async function (req, res) {
    const { method, url } = req;

    // ── Public ──────────────────────────────────────────
    if (url === "/health") {
      return json(res, 200, { status: "ok", sessions: sessions.size });
    }

    // ── Protected endpoints ─────────────────────────────
    if (!isAuthorized(req, nodeToken)) {
      // Return 401 only for known protected routes, 404 for everything else
      const protectedPrefixes = ["/stats", "/kick/", "/suspend/", "/resume/"];
      if (protectedPrefixes.some((p) => url.startsWith(p))) {
        return json(res, 401, { error: "unauthorized" });
      }
      res.writeHead(404);
      return res.end();
    }

    // GET /stats
    if (url === "/stats") {
      return json(res, 200, {
        sessions: [...sessions.values()].map((s) => s.stats()),
      });
    }

    // POST /kick/:keyId
    if (method === "POST" && url.startsWith("/kick/")) {
      const keyId = url.split("/")[2];
      const session = sessions.get(keyId);
      if (session) {
        session.destroy("key_deleted_by_web");
        sessions.delete(keyId);
        logger.info(`Manually kicked session`, { keyId });
      }
      return json(res, 200, { success: true, kicked: !!session });
    }

    // POST /suspend/:keyId
    if (method === "POST" && url.startsWith("/suspend/")) {
      const keyId = url.split("/")[2];
      const session = sessions.get(keyId);
      if (session) session.suspend();
      return json(res, 200, { success: true, suspended: !!session });
    }

    // POST /resume/:keyId
    if (method === "POST" && url.startsWith("/resume/")) {
      const keyId = url.split("/")[2];
      const session = sessions.get(keyId);
      let resumed = false;
      if (session) resumed = await session.resume();
      return json(res, 200, { success: true, resumed });
    }

    res.writeHead(404);
    res.end();
  };
}

module.exports = { createHttpHandler };
