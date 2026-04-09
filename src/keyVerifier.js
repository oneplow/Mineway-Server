"use strict";

const crypto = require("crypto");
const axios  = require("axios");
const logger = require("./logger");

// cache: keyHash -> { result, expiresAt }
// cache เฉพาะ valid=true เพื่อให้ revoke มีผลทันที (ไม่เกิน TTL)
const cache = new Map();

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function prunCache() {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}
setInterval(prunCache, 5 * 60_000).unref();

/**
 * ตรวจสอบ API key กับ Next.js web app
 * @returns {{ valid, keyId, userId, plan, maxPlayers, bandwidthRemaining, reason? }}
 */
async function verifyKey(rawKey, { webApiUrl, webApiSecret }) {
  if (!rawKey || !rawKey.startsWith("mct_")) {
    return { valid: false, reason: "invalid_format" };
  }

  const keyHash = hashKey(rawKey);
  const ttl     = parseInt(process.env.KEY_CACHE_TTL || "60") * 1000;

  // ตรวจ cache
  const hit = cache.get(keyHash);
  if (hit && hit.expiresAt > Date.now()) {
    logger.debug("Key cache hit", { keyId: hit.result.keyId });
    return hit.result;
  }

  // เรียก Next.js
  try {
    const res = await axios.post(
      `${webApiUrl}/api/internal/verify-key`,
      { key_hash: keyHash },
      {
        headers: {
          "x-internal-secret": webApiSecret,
          "content-type": "application/json",
        },
        timeout: 5000,
      }
    );

    const result = res.data;

    if (result.valid) {
      cache.set(keyHash, { result, expiresAt: Date.now() + ttl });
    }

    return result;
  } catch (err) {
    logger.error("Key verification failed", {
      status: err.response?.status,
      error:  err.message,
    });
    // fail closed — ถ้า web app ตอบไม่ได้ ไม่อนุญาต
    return { valid: false, reason: "verification_unavailable" };
  }
}

// เรียกเพื่อลบ cache เมื่อ revoke key ทันที
function burstCache(rawKey) {
  cache.delete(hashKey(rawKey));
}

module.exports = { verifyKey, burstCache, hashKey };
