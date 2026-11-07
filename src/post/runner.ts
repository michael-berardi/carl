// The real command runner: argv only (no shell), a deadline, never throws for a failing exit.
import { execFile } from "node:child_process";
import type { Runner } from "./types.ts";

/** Only what the browser and note tools need: Carl's own environment (API keys, tokens) is not handed to a child. */
const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|TZ|LC_[A-Z_]+|XDG_[A-Z_]+|HOMEBREW_[A-Z_]+|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;
export const childEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && KEEP.test(k) && !/(KEY|TOKEN|SECRET|PASSW|AUTH|CRED|COOKIE|SESSION)/i.test(k))) as Record<string, string>;

export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", env: childEnv(), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (e.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: `${cmd}: not found` });
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "", stderr: e.killed ? `${cmd} timed out` : (stderr || e.message) });
    });
  });
