import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let threshold: Level = "info";
let filePath: string | null = null;

export function configureLog(opts: { level?: Level; file?: string }): void {
  if (opts.level) threshold = opts.level;
  if (opts.file) {
    mkdirSync(dirname(opts.file), { recursive: true });
    filePath = opts.file;
  }
}

/** ISO 8601 in local time with the UTC offset (`2026-09-06T14:03:54-07:00`): readable where the user is, still unambiguous. */
export function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

function emit(level: Level, msg: string, data?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = `${localIso(new Date())} ${level.toUpperCase().padEnd(5)} ${msg}${data === undefined ? "" : " " + JSON.stringify(data)}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
  if (filePath) appendFileSync(filePath, line + "\n");
}

export const log = {
  debug: (msg: string, data?: unknown) => emit("debug", msg, data),
  info: (msg: string, data?: unknown) => emit("info", msg, data),
  warn: (msg: string, data?: unknown) => emit("warn", msg, data),
  error: (msg: string, data?: unknown) => emit("error", msg, data),
};
