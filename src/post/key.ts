// The approval key: approved_hash is an HMAC-SHA256 keyed from a 0600 file under CARL_HOME that the gateway creates and
// the shell sandbox denies (read and write). An unkeyed hash could be forged by anything that can write the draft.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PostError } from "./types.ts";

export const postKeyPath = (home: string) => join(home, "post-approval.key");

/** Create the key if it does not exist yet (0600, never overwritten), then read and check it. */
export function ensureKey(home: string): string {
  const path = postKeyPath(home);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) chmodSync(path, 0o600);
  const key = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new PostError(`${path} is not a valid approval key (64 hex characters); delete it to make a new one, which voids every approval`, true);
  return key;
}

export const hmac = (key: string, s: string) => createHmac("sha256", key).update(s).digest("hex");

/** Where OverSeer keeps its browser control socket, token and CLI runtime: out of the agent's reach whenever posting is configured. */
export function browserControlDirs(accounts: Record<string, unknown>): string[] {
  return Object.keys(accounts).length ? [join(homedir(), "Library", "Application Support", "OverSeer", "browser")] : [];
}

/** Session commands to resolve once from the operator's PATH at init (the gateway's own PATH is a private bin folder). */
export function sessionPrograms(accounts: Record<string, { session: { command: string } }>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const a of Object.values(accounts)) {
    const c = a.session.command;
    if (c.includes("/")) out[c.split("/").pop()!] = c; else out[c] = undefined;
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
