"use strict";

const crypto = require("crypto");
const axios  = require("axios");
const logger = require("./logger");

// cache: keyHash -> { result, expiresAt }
const cache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache.entries()) if (v.expiresAt <= now) cache.delete(k);
}, 5 * 60_000).unref();

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * ตรวจสอบ API key กับ Next.js web app
 * @returns {{ valid, keyId, userId, assignedPort, plan, maxPlayers, reason? }}
 */
async function verifyKey(rawKey, { webApiUrl, webApiSecret }) {
  if (!rawKey || !rawKey.startsWith("mw_")) {
    return { valid: false, reason: "invalid_format" };
  }

  const keyHash = hashKey(rawKey);
  const ttl = parseInt(process.env.KEY_CACHE_TTL || "60") * 1000;

  const hit = cache.get(keyHash);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  try {
    const res = await axios.post(
      `${webApiUrl}/api/internal/verify-key`,
      { key_hash: keyHash },
      {
        headers: { "x-internal-secret": webApiSecret, "content-type": "application/json" },
        timeout: 5000,
      }
    );
    const result = res.data;
    if (result.valid) cache.set(keyHash, { result, expiresAt: Date.now() + ttl });
    return result;
  } catch (err) {
    logger.error("Key verification failed", { status: err.response?.status, error: err.message });
    return { valid: false, reason: "verification_unavailable" };
  }
}

module.exports = { verifyKey, hashKey };
