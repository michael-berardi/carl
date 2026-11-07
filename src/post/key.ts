// The approval key lives only in the gateway's memory (generated when the gateway starts, never written to disk): an
// approval is an HMAC under it, so only the running gateway can make or check one. A fresh key per start voids older approvals.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { BrowserConfig } from "../config.ts";

export const newKey = (): string => randomBytes(32).toString("hex");

export const hmac = (key: string, s: string) => createHmac("sha256", key).update(s).digest("hex");

/** `~` and `~/x` in a configured path, expanded. */
export const expandHome = (p: string, home = homedir()) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

/**
 * The browser relay's control socket, token and runtime: out of the agent's reach whenever post.browser is set (with or without accounts). All of it
 * comes from the operator's `post.browser` config (nothing is assumed): the listed folders, the folders of the descriptor files
 * and the `runtime_root` they name, and any descriptor or runtime that the named environment variables point at.
 */
export function browserControlDirs(b: BrowserConfig, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dirs = new Set<string>(b.controlDirs);
  for (const descriptor of descriptorFiles(b, env, home)) {
    dirs.add(dirname(descriptor));
    try {
      const root = JSON.parse(readFileSync(descriptor, "utf8"))?.runtime_root;
      if (typeof root === "string" && root.startsWith("/")) { dirs.add(root); dirs.add(canon(root)); }
    } catch {}
  }
  for (const name of b.runtimeEnv) {
    const runtime = env[name]?.trim();
    if (runtime) { const r = resolve(expandHome(runtime, home)); dirs.add(r); dirs.add(canon(r)); }
  }
  return [...dirs];
}

function descriptorFiles(b: BrowserConfig, env: NodeJS.ProcessEnv, home: string): string[] {
  const files = [...b.descriptors];
  for (const name of b.descriptorEnv) {
    const v = env[name]?.trim();
    if (v && v !== "managed") files.push(resolve(expandHome(v, home)));
  }
  return files;
}

/** Session commands to resolve once from the operator's PATH at init (the gateway's own PATH is a private bin folder). */
export function sessionPrograms(accounts: Record<string, { session: { command: string } }>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const a of Object.values(accounts)) {
    const c = expandHome(a.session.command);
    if (c.includes("/")) out[c.split("/").pop()!] = c; else out[c] = undefined;
  }
  return out;
}

/**
 * Accounts whose session command cannot run: an absolute command that is not an executable file, or a name that was not
 * found on the operator's PATH when Carl started (`found` = what adoptTrustedPath resolved). Empty = every account can post.
 */
export function sessionProblems(accounts: Record<string, { session: { command: string } }>, found: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, a] of Object.entries(accounts)) {
    const c = expandHome(a.session.command);
    const path = c.includes("/") ? c : found[c];
    let ok = false;
    try { ok = !!path && statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0; } catch {}
    if (!ok) out.push(`account "${key}": session command "${a.session.command}" ${c.includes("/") ? "is not an executable file" : "was not found on the PATH Carl started with"}; nothing can be posted or dry-run from it. Set post.accounts.${key}.session.command to its absolute path in carl.json`);
  }
  return out;
}

/** Absolute path with the deepest existing ancestor resolved through symlinks (macOS /var is /private/var). */
export function canon(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (head !== "/" && !existsSync(head)) { tail.unshift(basename(head)); head = dirname(head); }
  try { head = realpathSync(head); } catch {}
  return tail.length ? join(head, ...tail) : head;
}

/** Is `p` inside (or equal to) `dir`, both resolved? */
export const inside = (p: string, dir: string) => { const a = canon(p); const b = canon(dir).replace(/\/+$/, ""); return a === b || a.startsWith(b + "/"); };

/**
 * Can the agent write `p`? The roots are its working areas and agentWritable entries. CARL_HOME is closed to it even when a
 * root contains it (the shell sandbox carves it out), except the working areas that live inside it.
 */
export const agentCanWrite = (p: string, roots: string[], home: string) =>
  roots.some((root) => inside(p, root) && !(inside(p, home) && !inside(root, home)));

/** The relay descriptors as they are now (their text, with the environment's overrides named too). Carl records it at start; posting refuses once it differs. */
export function relayFingerprint(b: BrowserConfig, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const files = descriptorFiles(b, env, home);
  const seen = files.map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } });
  return createHmac("sha256", "relay").update(JSON.stringify([files, seen, b.runtimeEnv.map((n) => env[n] ?? "")])).digest("hex");
}
