"use strict";

const axios  = require("axios");
const logger = require("./logger");

/**
 * รายงาน bandwidth ที่ใช้กลับไปยัง Next.js API
 * เรียกทุก 30 วินาที และทุกครั้งที่ session ถูก destroy
 */
class StatsReporter {
  constructor({ webApiUrl, webApiSecret }) {
    this.webApiUrl    = webApiUrl;
    this.webApiSecret = webApiSecret;

    // pending: keyId -> { rxBytes, txBytes } (BigInt สะสม ยังไม่ได้ส่ง)
    this.pending = new Map();

    // flush ทุก 30 วินาที
    this._timer = setInterval(() => this.flush(), 30_000);
    this._timer.unref();
  }

  // เพิ่ม bytes ให้ key นั้น (เรียกบ่อยได้ ไม่ได้ส่ง API ทันที)
  record(keyId, rxBytes, txBytes) {
    const cur = this.pending.get(keyId) || { rx: BigInt(0), tx: BigInt(0) };
    this.pending.set(keyId, {
      rx: cur.rx + BigInt(rxBytes),
      tx: cur.tx + BigInt(txBytes),
    });
  }

  // เรียกตอน session destroy — บังคับ flush ของ key นี้ทันที
  async recordAndFlush(keyId, rxBytes, txBytes) {
    this.record(keyId, rxBytes, txBytes);
    await this.flushKey(keyId);
  }

  async flushKey(keyId) {
    const data = this.pending.get(keyId);
    if (!data || (data.rx === BigInt(0) && data.tx === BigInt(0))) return;
    this.pending.delete(keyId);
    await this._send(keyId, data.rx, data.tx);
  }

  async flush() {
    const entries = [...this.pending.entries()];
    this.pending.clear();

    await Promise.allSettled(
      entries.map(([keyId, data]) => this._send(keyId, data.rx, data.tx))
    );
  }

  async _send(keyId, rx, tx) {
    try {
      await axios.post(
        `${this.webApiUrl}/api/internal/report-usage`,
        { keyId, rxBytes: rx.toString(), txBytes: tx.toString() },
        {
          headers: {
            "x-internal-secret": this.webApiSecret,
            "content-type":      "application/json",
          },
          timeout: 5000,
        }
      );
      logger.debug("Usage reported", { keyId, rx: rx.toString(), tx: tx.toString() });
    } catch (err) {
      logger.error("Failed to report usage", { keyId, error: err.message });
      // ใส่กลับ pending เพื่อ retry รอบหน้า
      const cur = this.pending.get(keyId) || { rx: BigInt(0), tx: BigInt(0) };
      this.pending.set(keyId, { rx: cur.rx + rx, tx: cur.tx + tx });
    }
  }

  stop() {
    clearInterval(this._timer);
    return this.flush(); // flush ทุกอย่างก่อน shutdown
  }
}

module.exports = StatsReporter;
