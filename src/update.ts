// Self-update: Carl checks its own GitHub releases, says when it is out of date, installs a release and restarts on it.
//
// One outbound request, to GitHub, at most once a day: the latest release's tag. It carries no id, no version, no usage
// and nothing about the machine (User-Agent "carl"). Turn it off with "update": {"check": false} or CARL_OFFLINE=1.
//
// Two install kinds update in place:
//   - a release folder reached through a symlink (`<app>/current -> <app>/release-<ver>-<sha12>`): the new release is
//     unpacked beside it, its dependencies installed and smoke-tested, then the link is swapped atomically. The previous
//     release stays as `<link>.previous` (one rollback per link); Carl's own release folders no link uses are removed.
//   - a git checkout (the README install): fast-forward to the release tag, then `npm ci --omit=dev`.
// A running gateway restarts on the new code once nothing is running (SIGUSR2: it re-executes itself, same pid).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { carlHome, type CarlConfig } from "./config.ts";
import type { Gateway, GatewayPlugin } from "./gateway.ts";
import { VERSION } from "./version.ts";

export const ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const DAY_MS = 24 * 3600_000;

export class UpdateError extends Error {
  override name = "UpdateError";
}

export interface Release { version: string; tag: string; notes: string; url: string }

/** "owner/repo" from package.json's repository URL: Carl updates from where it was published, never a built-in host. */
export function repoSlug(root = ROOT): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const url = String(pkg.repository?.url ?? pkg.repository ?? "");
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new UpdateError(`package.json repository (${url || "unset"}) is not a GitHub repository; self-update needs GitHub releases`);
  return m[1];
}

const apiBase = () => (process.env.CARL_UPDATE_API ?? "https://api.github.com").replace(/\/+$/, "");
const codeloadBase = () => (process.env.CARL_UPDATE_CODELOAD ?? "https://codeload.github.com").replace(/\/+$/, "");
const HEADERS = { "user-agent": "carl", accept: "application/vnd.github+json" };

/** True when `a` is a newer x.y.z than `b`. */
export function isNewer(a: string, b: string): boolean {
  const p = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => Number(n) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export async function latestRelease(slug = repoSlug()): Promise<Release> {
  const res = await fetch(`${apiBase()}/repos/${slug}/releases/latest`, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new UpdateError(`GitHub answered ${res.status} for the latest release of ${slug}`);
  const j: any = await res.json();
  if (typeof j.tag_name !== "string" || !/^v?\d+\.\d+\.\d+$/.test(j.tag_name)) throw new UpdateError(`the latest release of ${slug} has no x.y.z tag (${JSON.stringify(j.tag_name)})`);
  return { tag: j.tag_name, version: j.tag_name.replace(/^v/, ""), notes: String(j.body ?? "").trim(), url: String(j.html_url ?? "") };
}

// ---- install kinds -------------------------------------------------------------------------------------------

export type Install =
  | { kind: "release"; root: string; link: string; appDir: string }
  | { kind: "git"; root: string }
  | { kind: "other"; root: string; why: string };

/**
 * How this copy was installed. `entry` is the path Carl was started through (bin/carl exports it as CARL_ENTRY before
 * resolving links): when it is `<app>/<link>/bin/carl` and `<link>` is a symlink to this release, that link is the one to move.
 */
export function detectInstall(root = ROOT, entry = process.env.CARL_ENTRY): Install {
  if (entry) {
    const link = dirname(dirname(entry));
    try {
      if (lstatSync(link).isSymbolicLink() && realpathSync(link) === root) return { kind: "release", root, link, appDir: dirname(link) };
    } catch {}
  }
  if (existsSync(join(root, ".git"))) return { kind: "git", root };
  return { kind: "other", root, why: `${root} is neither a git checkout nor a release folder reached through a symlink` };
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000, input?: Buffer): string {
  const r = spawnSync(cmd, args, { cwd, input, timeout: timeoutMs, maxBuffer: 64 << 20,
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" } });
  if (r.error) throw new UpdateError(`${basename(cmd)} ${args[0]} failed: ${r.error.message}`);
  if (r.status !== 0) throw new UpdateError(`${basename(cmd)} ${args.join(" ").slice(0, 80)} failed (exit ${r.status}): ${String(r.stderr).trim().slice(-600)}`);
  return String(r.stdout);
}

/** npm beside the running Node (a bundled runtime ships one), else npm on PATH. */
function npm(): string {
  const beside = join(dirname(realpathSync(process.execPath)), "npm");
  return existsSync(beside) ? beside : "npm";
}

/**
 * Install dependencies and prove the new copy works: every runtime dependency loads, and its `bin/carl --version`
 * reports the release's version.
 */
function prepare(dir: string, version: string): void {
  run(npm(), ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], dir);
  const deps = Object.keys(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies ?? {});
  if (deps.length) run(process.execPath, ["--input-type=module", "-e", `for (const d of ${JSON.stringify(deps)}) await import(d);`], dir, 120_000);
  const out = run(join(dir, "bin", "carl"), ["--version"], dir, 60_000).trim();
  if (!out.startsWith(version)) throw new UpdateError(`the new copy reports "${out.slice(0, 80)}", not ${version}; nothing was switched`);
}

export interface Installed { from: string; to: string; path: string }

export async function install(rel: Release, inst: Install, slug = repoSlug(inst.root)): Promise<Installed> {
  if (inst.kind === "other") throw new UpdateError(`cannot update in place: ${inst.why}. Reinstall from https://github.com/${slug}`);
  if (inst.kind === "git") {
    const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], inst.root).trim();
    if (dirty) throw new UpdateError(`${inst.root} has local changes; commit or stash them, then run carl update again`);
    run("git", ["fetch", "--quiet", "--tags", "origin"], inst.root, 120_000);
    run("git", ["merge", "--ff-only", "--quiet", `refs/tags/${rel.tag}`], inst.root);
    prepare(inst.root, rel.version);
    return { from: VERSION, to: rel.version, path: inst.root };
  }
  // A release folder: unpack beside the current one, prepare it, then swap the link.
  const shaRes = await fetch(`${apiBase()}/repos/${slug}/commits/${encodeURIComponent(rel.tag)}`, { headers: { ...HEADERS, accept: "application/vnd.github.sha" }, signal: AbortSignal.timeout(15_000) });
  const sha = (await shaRes.text()).trim();
  if (!shaRes.ok || !/^[0-9a-f]{40}$/.test(sha)) throw new UpdateError(`cannot resolve ${rel.tag} to a commit (GitHub ${shaRes.status})`);
  const target = join(inst.appDir, `release-${rel.version}-${sha.slice(0, 12)}`);
  const commitOf = (dir: string) => { try { return readFileSync(join(dir, "COMMIT"), "utf8").trim(); } catch { return ""; } };
  if (inst.root === target) throw new UpdateError(`${rel.tag} is already installed at ${target}`);
  // Another link (a second bot on the same app folder) already moved to this release: share it.
  if (commitOf(target) === sha && linkedTargets(inst.appDir).has(realpathSync(target))) {
    swapLink(`${inst.link}.previous`, inst.root);
    swapLink(inst.link, target);
    prune(inst.appDir);
    return { from: VERSION, to: rel.version, path: target };
  }
  const tar = await fetch(`${codeloadBase()}/${slug}/tar.gz/${sha}`, { headers: { "user-agent": "carl" }, signal: AbortSignal.timeout(300_000) });
  if (!tar.ok) throw new UpdateError(`download of ${rel.tag} failed (HTTP ${tar.status})`);
  const incoming = join(inst.appDir, `.incoming-${rel.version}-${randomBytes(4).toString("hex")}`);
  mkdirSync(incoming, { mode: 0o700 });
  try {
    run("/usr/bin/tar", ["-xzf", "-", "-C", incoming, "--strip-components=1"], incoming, 120_000, Buffer.from(await tar.arrayBuffer()));
    const version = JSON.parse(readFileSync(join(incoming, "package.json"), "utf8")).version;
    if (version !== rel.version) throw new UpdateError(`${rel.tag} contains version ${version}; nothing was switched`);
    // The release's own runtime link (a host that bundles Node puts one beside bin/) carries over.
    const node = join(inst.root, "node");
    if (lstatSync(node, { throwIfNoEntry: false })?.isSymbolicLink()) symlinkSync(readlinkSync(node), join(incoming, "node"));
    writeFileSync(join(incoming, "COMMIT"), sha + "\n", { mode: 0o600 });
    writeFileSync(join(incoming, "CARL-SOURCE.json"), JSON.stringify({ name: "carl-gateway", version, commit: sha, repository: `https://github.com/${slug}` }, null, 2), { mode: 0o600 });
    prepare(incoming, rel.version);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true }); // a leftover no link uses
    renameSync(incoming, target);
    swapLink(`${inst.link}.previous`, inst.root);
    swapLink(inst.link, target);
    prune(inst.appDir);
    return { from: VERSION, to: version, path: target };
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
}

/** Point `link` at `target` atomically (a new link renamed over the old). */
function swapLink(link: string, target: string): void {
  const tmp = `${link}.tmp-${randomBytes(4).toString("hex")}`;
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

function linkedTargets(appDir: string): Set<string> {
  const out = new Set<string>();
  for (const name of readdirSync(appDir)) {
    try { if (lstatSync(join(appDir, name)).isSymbolicLink()) out.add(realpathSync(join(appDir, name))); } catch {}
  }
  return out;
}

/** Remove Carl's own release folders that no link uses. Other folders (a host's bundled copies, say) are never touched. */
export function prune(appDir: string): string[] {
  const keep = linkedTargets(appDir);
  const removed: string[] = [];
  for (const name of readdirSync(appDir)) {
    const path = join(appDir, name);
    if (!/^release-\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(name)) continue;
    if (lstatSync(path).isSymbolicLink() || keep.has(realpathSync(path))) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export function rollback(inst: Install): string {
  if (inst.kind !== "release") throw new UpdateError(inst.kind === "git" ? `in a git checkout, check out the version you want (git -C ${inst.root} tag) and run npm ci --omit=dev` : `cannot roll back: ${inst.why}`);
  const prev = `${inst.link}.previous`;
  if (!lstatSync(prev, { throwIfNoEntry: false })?.isSymbolicLink() || !existsSync(prev)) throw new UpdateError(`no previous release is kept (${prev})`);
  const target = realpathSync(prev);
  swapLink(prev, inst.root);
  swapLink(inst.link, target);
  return target;
}

// ---- state -------------------------------------------------------------------------------------------------

interface State { checkedAt?: number; latest?: string; notified?: string; installed?: { from: string; to: string; at: number }; error?: string }
const stateFile = (home: string) => join(home, "state", "update.json");
export function readState(home: string): State {
  try { return JSON.parse(readFileSync(stateFile(home), "utf8")); } catch { return {}; }
}
function writeState(home: string, patch: Partial<State>): void {
  const next = { ...readState(home), ...patch };
  mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(home) + ".tmp", JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(stateFile(home) + ".tmp", stateFile(home));
}

/** The newer version the last check saw, if any (for `carl status`, /status and the web app). */
export function availableUpdate(home: string): string | undefined {
  const s = readState(home);
  return s.latest && isNewer(s.latest, VERSION) ? s.latest : undefined;
}

export function checksEnabled(cfg: Pick<CarlConfig, "update">, env = process.env): boolean {
  return cfg.update.check && !/^(1|true|yes)$/i.test(env.CARL_OFFLINE ?? "");
}

/** First version whose gateway restarts itself on SIGUSR2; an older one would simply be killed by the signal. */
const RESTARTS_ON_SIGNAL = "0.10.0";

/** Ask the gateway on this home to restart on the installed code once it is idle. */
function signalGateway(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, "state", "gateway.pid"), "utf8").trim());
    if (!pid) return undefined;
    const running = String(JSON.parse(readFileSync(join(home, "state", "status.json"), "utf8")).version ?? "0");
    if (isNewer(RESTARTS_ON_SIGNAL, running)) return undefined;
    const cmd = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 }).stdout ?? "";
    if (!/main\.ts gateway/.test(cmd)) return undefined;
    process.kill(pid, "SIGUSR2");
    return pid;
  } catch { return undefined; }
}

// ---- CLI ---------------------------------------------------------------------------------------------------

export async function updateCommand(args: string[]): Promise<number> {
  const home = carlHome();
  const inst = detectInstall();
  try {
    if (args.includes("--rollback")) {
      const to = rollback(inst);
      console.log(`Rolled back to ${basename(to)}.`);
      const pid = signalGateway(home);
      if (pid) console.log(`The gateway (pid ${pid}) restarts on it once nothing is running.`);
      return 0;
    }
    const rel = await latestRelease();
    writeState(home, { checkedAt: Date.now(), latest: rel.version, error: undefined });
    if (!isNewer(rel.version, VERSION)) {
      console.log(`Carl ${VERSION} is up to date.`);
      return 0;
    }
    console.log(`Carl ${rel.version} is available (you run ${VERSION}).${rel.url ? `\n${rel.url}` : ""}`);
    if (args.includes("--check")) return 10;
    console.log(inst.kind === "release" ? `Installing beside ${inst.root} ...` : `Updating ${inst.root} ...`);
    const done = await install(rel, inst);
    writeState(home, { installed: { from: done.from, to: done.to, at: Date.now() } });
    console.log(`Installed Carl ${done.to} (${done.path}).${inst.kind === "release" ? " Undo with: carl update --rollback" : ""}`);
    const pid = signalGateway(home);
    console.log(pid ? `The gateway (pid ${pid}) restarts on ${done.to} once nothing is running.` : "Start or restart the gateway to run it.");
    return 0;
  } catch (e) {
    console.error(`carl update: ${(e as Error).message}`);
    return 1;
  }
}

// ---- gateway plugin ----------------------------------------------------------------------------------------

/**
 * In the gateway: a daily check that tells the home chat once per new version, the /update command, optional
 * automatic install (`update.auto`), and an "updated" note after the restart.
 */
export class UpdatePlugin implements GatewayPlugin {
  readonly name = "update";
  private timer?: NodeJS.Timeout;
  private gw?: Gateway;
  private installing = false;

  start(gw: Gateway): void {
    this.gw = gw;
    const home = gw.cfg.home;
    gw.telegram?.commands.set("update", { help: "Check for a new Carl release and install it", run: (args) => this.command(args) });
    const s = readState(home);
    if (s.installed && s.installed.to === VERSION) {
      writeState(home, { installed: undefined });
      setTimeout(() => this.tell(`Carl updated: ${s.installed!.from} → ${VERSION}.`), 5_000).unref();
    }
    if (!checksEnabled(gw.cfg)) return;
    const due = Math.max(60_000, (s.checkedAt ?? 0) + DAY_MS - Date.now());
    this.timer = setTimeout(() => void this.tick(), due);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); }

  private tell(text: string): void {
    const gw = this.gw!;
    if (!gw.telegram || !gw.cfg.telegram.homeChat) return void gw.log.info("update notice (no Telegram home chat)", { text });
    void gw.send("home", text).catch((e) => gw.log.warn("update notice not delivered", { error: (e as Error).message }));
  }

  private async tick(): Promise<void> {
    const gw = this.gw!;
    try {
      const rel = await latestRelease();
      const s = readState(gw.cfg.home);
      writeState(gw.cfg.home, { checkedAt: Date.now(), latest: rel.version, error: undefined });
      if (isNewer(rel.version, VERSION) && s.notified !== rel.version) {
        writeState(gw.cfg.home, { notified: rel.version });
        if (gw.cfg.update.auto) await this.apply(rel);
        else this.tell(`Carl ${rel.version} is available (this is ${VERSION}).\n\n${summary(rel.notes)}\n\nSend /update to install it. Carl restarts on it once nothing is running.`);
      }
    } catch (e) {
      gw.log.warn("update check failed", { error: (e as Error).message });
      writeState(gw.cfg.home, { checkedAt: Date.now(), error: (e as Error).message });
    }
    this.timer = setTimeout(() => void this.tick(), DAY_MS);
    this.timer.unref();
  }

  /**
   * Install through `carl update` in a child process: npm runs there, so the gateway keeps answering meanwhile. The child
   * signals this gateway (SIGUSR2), which restarts on the new code once nothing is running.
   */
  private async apply(rel: Release): Promise<string> {
    if (this.installing) return "An update is already being installed.";
    this.installing = true;
    const gw = this.gw!;
    try {
      const entry = process.env.CARL_ENTRY;
      const argv = entry ? ["/bin/sh", entry, "update"] : [process.execPath, "--experimental-strip-types", "--no-warnings", join(ROOT, "src", "main.ts"), "update"];
      const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, CARL_HOME: gw.cfg.home }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const code = await new Promise<number>((ok) => { child.on("error", (e) => { out += e.message; ok(1); }); child.on("close", (c) => ok(c ?? 1)); });
      const tail = out.trim().split("\n").slice(-3).join("\n");
      if (code !== 0) throw new UpdateError(tail || `carl update exited ${code}`);
      gw.log.info("update installed", { to: rel.version });
      return `${tail}\n\nCarl restarts on ${rel.version} once nothing is running.`;
    } catch (e) {
      gw.log.error("update failed", { error: (e as Error).message });
      const msg = `Update to ${rel.version} failed: ${(e as Error).message}\nCarl keeps running ${VERSION}.`;
      if (gw.cfg.update.auto) this.tell(msg);
      return msg;
    } finally {
      this.installing = false;
    }
  }

  private async command(args: string): Promise<string> {
    const rel = await latestRelease();
    writeState(this.gw!.cfg.home, { checkedAt: Date.now(), latest: rel.version, error: undefined });
    if (!isNewer(rel.version, VERSION)) return `Carl ${VERSION} is up to date.`;
    if (/^check\b/i.test(args.trim())) return `Carl ${rel.version} is available (this is ${VERSION}).\n\n${summary(rel.notes)}\n\nSend /update to install it.`;
    return this.apply(rel);
  }
}

function summary(notes: string): string {
  const lines = notes.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6).join("\n");
  return lines.length > 900 ? lines.slice(0, 900) + "…" : lines || "(no release notes)";
}
