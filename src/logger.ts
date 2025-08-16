// src/logger.ts
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

const order: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40, silent: 99,
};

function shouldLog(level: LogLevel) {
  return order[level] >= order[currentLevel];
}

function fmt(prefix: string) {
  const ts = new Date().toISOString();
  return `[${prefix}] [${ts}]`;
}

export const Logger = {
  setLevel(l: LogLevel) { currentLevel = l; },
  debug(prefix: string, msg: string) { if (shouldLog("debug")) console.log(`${fmt(prefix)} ${msg}`); },
  info(prefix: string, msg: string)  { if (shouldLog("info"))  console.log(`${fmt(prefix)} ${msg}`); },
  warn(prefix: string, msg: string)  { if (shouldLog("warn"))  console.warn(`${fmt(prefix)} ${msg}`); },
  error(prefix: string, msg: string) { if (shouldLog("error")) console.error(`${fmt(prefix)} ${msg}`); },
};
