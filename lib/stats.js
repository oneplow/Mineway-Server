"use strict";

const axios  = require("axios");
const logger = require("./logger");

/**
 * StatsReporter — รายงาน bandwidth กลับไปยัง Next.js API
 * flush ทุก 30 วินาที และทุกครั้งที่ session ถูก destroy
 */
class StatsReporter {
  constructor({ webApiUrl, webApiSecret }) {
    this.webApiUrl    = webApiUrl;
    this.webApiSecret = webApiSecret;
    this.pending      = new Map(); // keyId -> { rx: BigInt, tx: BigInt }

    this._timer = setInterval(() => this.flush(), 30_000);
    this._timer.unref();
  }

  record(keyId, rxBytes, txBytes) {
    const cur = this.pending.get(keyId) || { rx: BigInt(0), tx: BigInt(0) };
    this.pending.set(keyId, {
      rx: cur.rx + BigInt(rxBytes),
      tx: cur.tx + BigInt(txBytes),
    });
  }

  async recordAndFlush(keyId, rxBytes, txBytes) {
    this.record(keyId, rxBytes, txBytes);
    await this._flushKey(keyId);
  }

  async _flushKey(keyId) {
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
          headers: { "x-internal-secret": this.webApiSecret, "content-type": "application/json" },
          timeout: 5000,
        }
      );
    } catch (err) {
      logger.error("Failed to report usage", { keyId, error: err.message });
      // ใส่กลับ pending เพื่อ retry รอบหน้า
      const cur = this.pending.get(keyId) || { rx: BigInt(0), tx: BigInt(0) };
      this.pending.set(keyId, { rx: cur.rx + rx, tx: cur.tx + tx });
    }
  }

  stop() {
    clearInterval(this._timer);
    return this.flush();
  }
}

module.exports = StatsReporter;
