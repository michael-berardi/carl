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

/** `~` and `~/x` in a configured path, expanded. */
export const expandHome = (p: string, home = homedir()) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

/**
 * Where overseer-browser keeps its control socket, token and runtime: out of the agent's reach whenever posting is
 * configured. The Application Support folder is the managed runtime; the operator-relay descriptor
 * (~/.config/overseer-browser/active-connection.json, or $OVERSEER_BROWSER_CONNECTION) names another `runtime_root` that holds the
 * socket and the token; $OVERSEER_BROWSER_RUNTIME names one too. The descriptor's own folder is closed as well. The relay's socket
 * is additionally refused by name wherever it lives (see the sandbox profile).
 */
export function browserControlDirs(accounts: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (!Object.keys(accounts).length) return [];
  const dirs = new Set<string>([join(home, "Library", "Application Support", "OverSeer", "browser"), join(home, ".config", "overseer-browser")]);
  // Both the default descriptor (what a posting child sees: runner.ts strips OVERSEER_* from its environment) and the one this
  // process's own environment names are closed, so the sandbox and the posting CLI cannot be looking at different relays.
  const override = env.OVERSEER_BROWSER_CONNECTION?.trim();
  const descriptors = [join(home, ".config", "overseer-browser", "active-connection.json")];
  if (override && override !== "managed") descriptors.push(resolve(expandHome(override, home)));
  for (const descriptor of descriptors) {
    dirs.add(dirname(descriptor));
    try {
      const root = JSON.parse(readFileSync(descriptor, "utf8"))?.runtime_root;
      if (typeof root === "string" && root.startsWith("/")) { dirs.add(root); dirs.add(canon(root)); }
    } catch {}
  }
  const runtime = env.OVERSEER_BROWSER_RUNTIME?.trim();
  if (runtime) { const r = resolve(expandHome(runtime, home)); dirs.add(r); dirs.add(canon(r)); }
  return [...dirs];
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

/** The relay descriptor as it is now (its text, with the environment's override named too). Carl records it at start; posting refuses once it differs. */
export function relayFingerprint(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.OVERSEER_BROWSER_CONNECTION?.trim();
  const files = [join(home, ".config", "overseer-browser", "active-connection.json"), ...(override && override !== "managed" ? [resolve(expandHome(override, home))] : [])];
  const seen = files.map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } });
  return createHmac("sha256", "relay").update(JSON.stringify([files, seen, env.OVERSEER_BROWSER_RUNTIME ?? ""])).digest("hex");
}
