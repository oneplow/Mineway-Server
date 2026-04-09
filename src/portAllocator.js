"use strict";

const logger = require("./logger");

class PortAllocator {
  constructor() {
    const start = parseInt(process.env.PORT_RANGE_START || "25500");
    const end   = parseInt(process.env.PORT_RANGE_END   || "25999");

    this.pool  = new Set();
    this.inUse = new Map(); // port -> keyId

    for (let p = start; p <= end; p++) this.pool.add(p);

    logger.info("PortAllocator ready", { start, end, total: this.pool.size });
  }

  allocate(keyId) {
    if (this.pool.size === 0) return null;
    const port = this.pool.values().next().value;
    this.pool.delete(port);
    this.inUse.set(port, keyId);
    return port;
  }

  release(port) {
    if (this.inUse.has(port)) {
      this.inUse.delete(port);
      this.pool.add(port);
    }
  }

  stats() {
    return { total: this.pool.size + this.inUse.size, used: this.inUse.size, free: this.pool.size };
  }
}

module.exports = new PortAllocator();
