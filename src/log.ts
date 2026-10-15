// JSON-lines log to CARL_HOME/logs/carl.log and a readable line on stderr. Never log secrets or message bodies at info level.
import { appendFileSync, renameSync, statSync } from "node:fs";

type Level = "debug" | "info" | "warn" | "error";
const MAX_BYTES = 10 * 1024 * 1024;

export class Log {
  private readonly file?: string;
  private readonly verbose: boolean;
  constructor(file?: string, verbose = false) {
    this.file = file;
    this.verbose = verbose;
  }

  private write(level: Level, msg: string, data?: Record<string, unknown>): void {
    if (level === "debug" && !this.verbose) return;
    const at = new Date().toISOString();
    const line = JSON.stringify({ at, level, msg, ...data });
    if (this.file) {
      try {
        if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(this.file, `${this.file}.1`);
        appendFileSync(this.file, line + "\n", { mode: 0o600 });
      } catch (e) {
        process.stderr.write(`carl: cannot write log ${this.file}: ${(e as Error).message}\n`);
      }
    }
    const extra = data && Object.keys(data).length ? " " + Object.entries(data).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ") : "";
    process.stderr.write(`${at.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}${extra}\n`);
  }

  debug(msg: string, data?: Record<string, unknown>) { this.write("debug", msg, data); }
  info(msg: string, data?: Record<string, unknown>) { this.write("info", msg, data); }
  warn(msg: string, data?: Record<string, unknown>) { this.write("warn", msg, data); }
  error(msg: string, data?: Record<string, unknown>) { this.write("error", msg, data); }
}
