"use strict";
require("dotenv").config();

const TunnelServer = require("./src/tunnelServer");
const logger       = require("./src/logger");

const server = new TunnelServer({
  wsPort:       parseInt(process.env.WS_PORT    || "8765"),
  webApiUrl:    process.env.WEB_API_URL     || "http://localhost:3000",
  webApiSecret: process.env.INTERNAL_SECRET || "change-me",
  baseDomain:   process.env.BASE_DOMAIN     || "mctunnel.io",
});

server.start();

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down...`);
  await server.stop();
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException",  (err) => logger.error("Uncaught",  { error: err.message }));
process.on("unhandledRejection", (r)   => logger.error("Unhandled", { reason: String(r)  }));
