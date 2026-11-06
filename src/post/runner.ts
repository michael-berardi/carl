// The real command runner: argv only (no shell), a deadline, never throws for a failing exit.
import { execFile } from "node:child_process";
import type { Runner } from "./types.ts";

export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: opts.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (e.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: `${cmd}: not found` });
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "", stderr: e.killed ? `${cmd} timed out` : (stderr || e.message) });
    });
  });
