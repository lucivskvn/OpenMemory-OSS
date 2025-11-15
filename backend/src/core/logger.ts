import pino from "pino";
// Use pino-pretty transport when LOG_PRETTY is enabled
// pino.transport is used to route logs through pino-pretty for human-friendly output
// only when LOG_PRETTY=true. In CI/containers, the default remains concise JSON.

// Environment-driven logging behavior:
// - LOG_LEVEL: controls the minimum log level (default: "info")
// - LOG_VERBOSE: when "1" or "true", enables debug-level logging and includes more fields
// Notes: timestamps are emitted in the server's local timezone (human-friendly) and
// are included under the `time` field. Logs are JSON by default for easy parsing in CI/containers.

const DEFAULT_LEVEL = process.env.LOG_LEVEL || "info";
const VERBOSE = (process.env.LOG_VERBOSE || "").toLowerCase() === "1" || (process.env.LOG_VERBOSE || "").toLowerCase() === "true";

import os from "os";
// Invert default: pretty logs are enabled by default for local dev. Set
// LOG_PRETTY=0 or LOG_PRETTY=false to force machine-friendly JSON output.
const PRETTY = !((process.env.LOG_PRETTY || "").toLowerCase() === "0" || (process.env.LOG_PRETTY || "").toLowerCase() === "false");

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function timestampWithOffset(): string {
  // Return a compact local timestamp with numeric offset, e.g. ,"time":"2025-11-11 14:03:12 +02:00"
  try {
    const d = new Date();
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    const offsetMin = -d.getTimezoneOffset(); // minutes east of UTC
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const offH = pad(Math.floor(abs / 60));
    const offM = pad(abs % 60);
    return `,\"time\":\"${y}-${m}-${day} ${hh}:${mm}:${ss} ${sign}${offH}:${offM}\"`;
  } catch (err) {
    return `,\"time\":\"${new Date().toISOString()}Z\"`;
  }
}

// Build logger instance: when PRETTY is enabled, create a pino transport to
// pino-pretty for human-friendly console output; otherwise emit JSON with
// a local numeric-offset timestamp under the `time` field.
let logger: any;

if (PRETTY) {
  // Use pino transport -> pino-pretty for rich colored output and translateTime
  // Keep JSON fields minimal by ignoring pid/hostname which are noisy for local dev.
  // Note: pino.transport is synchronous in Node; Bun supports pino and transports.
  try {
    const transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        singleLine: true,
      },
    });
    logger = pino({
      level: VERBOSE ? 'debug' : DEFAULT_LEVEL,
      formatters: { level: (label: string) => ({ level: label }) },
      timestamp: timestampWithOffset,
    }, transport);
  } catch (e) {
    // If transports are not available in the runtime, fall back to a very small
    // human fallback so the server remains usable.
    const fallback = (msg: string, meta?: any) => console.log(`${new Date().toISOString()} INFO ${msg}`, meta || '');
    logger = {
      level: VERBOSE ? 'debug' : DEFAULT_LEVEL,
      debug: (m: any, meta?: any) => fallback(m, meta),
      info: (m: any, meta?: any) => fallback(m, meta),
      warn: (m: any, meta?: any) => console.warn(m, meta),
      error: (m: any, meta?: any) => console.error(m, meta),
      fatal: (m: any, meta?: any) => console.error(m, meta),
      child: (_: any) => logger,
    } as any;
  }
} else {
  logger = pino({
    level: VERBOSE ? "debug" : DEFAULT_LEVEL,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // pino expects the timestamp function to return a string starting with a comma.
    timestamp: timestampWithOffset,
  });
}

export default logger;
