"use strict";

function log(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, msg: message, ...meta };
  const line = JSON.stringify(entry);
  if (level === "ERROR") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

module.exports = {
  info:  (msg, meta) => log("INFO",  msg, meta),
  warn:  (msg, meta) => log("WARN",  msg, meta),
  error: (msg, meta) => log("ERROR", msg, meta),
  debug: (msg, meta) => { if (process.env.DEBUG) log("DEBUG", msg, meta); },
};
