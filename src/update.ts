// Self-update: Carl checks its own GitHub releases, says when it is out of date, installs a release and restarts on it.
//
// One outbound request, to GitHub, at most once a day: the latest release record. It carries no id, no version, no usage
// and nothing about the machine (User-Agent "carl-update-check"). The answer, or the failure's cause, is cached in one
// file under the platform cache dir; `carl update --check` shows it. Checks are off with "update": {"check": false},
// CARL_OFFLINE=1 or CARL_NO_UPDATE_CHECK=1. The terminal notice is also off without a TTY, in CI and in agent sessions.
//
// Two install kinds update in place:
//   - a release folder reached through a symlink (`<app>/current -> <app>/release-<ver>-<sha12>`): the release's
//     `carl.tar.gz` is checked against its `SHA256SUMS`, unpacked beside the current one, its dependencies installed and
//     smoke-tested, then the link is swapped atomically. The previous release stays as `<link>.previous` (one rollback per
//     link) until the new version has run once, or seven days; Carl's own release folders no link uses are removed.
//   - a git checkout (the README install): fast-forward to the release tag, then `npm ci --omit=dev`.
// A running gateway restarts on the new code once nothing is running (SIGUSR2: it re-executes itself, same pid).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir, setPriority } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { carlHome, loadConfig, type CarlConfig } from "./config.ts";
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
const downloadBase = () => (process.env.CARL_UPDATE_DOWNLOAD ?? "https://github.com").replace(/\/+$/, "");
const HEADERS = { "user-agent": "carl-update-check", accept: "application/vnd.github+json" };
const STABLE = /^v?\d+\.\d+\.\d+$/;

/** True when `a` is a newer stable x.y.z than `b`; prereleases and unparseable versions are never newer. */
export function isNewer(a: string, b: string): boolean {
  if (!STABLE.test(a) || !STABLE.test(b)) return false;
  const [x, y] = [a, b].map((v) => v.replace(/^v/, "").split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export async function latestRelease(slug = repoSlug(), timeoutMs = 4_000): Promise<Release> {
  const res = await fetch(`${apiBase()}/repos/${slug}/releases/latest`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new UpdateError(`GitHub answered ${res.status} for the latest release of ${slug}`);
  const j: any = await res.json();
  if (j.draft || j.prerelease) throw new UpdateError(`the latest release of ${slug} is a draft or prerelease`);
  if (typeof j.tag_name !== "string" || !STABLE.test(j.tag_name)) throw new UpdateError(`the latest release of ${slug} has no x.y.z tag (${JSON.stringify(j.tag_name)})`);
  return { tag: j.tag_name, version: j.tag_name.replace(/^v/, ""), notes: String(j.body ?? "").trim(), url: String(j.html_url ?? "") };
}

// ---- check cache and notices -----------------------------------------------------------------------------------

/**
 * The one file the check writes, shared by every CARL_HOME on the machine: when it ran, the latest version and a short
 * excerpt of its notes (or the failure's cause), and which version the terminal notice last showed.
 */
interface CheckCache { checkedAt: number; version?: string; notes?: string; error?: string; shown?: string; shownAt?: number }

/** `CARL_UPDATE_CACHE_DIR` is for tests and unusual layouts. */
export function cacheDir(): string {
  if (process.env.CARL_UPDATE_CACHE_DIR) return process.env.CARL_UPDATE_CACHE_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "carl");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "carl");
}
export const cacheFile = () => join(cacheDir(), "update-check.json");

export function readCheckCache(): CheckCache | undefined {
  try {
    const c = JSON.parse(readFileSync(cacheFile(), "utf8"));
    return typeof c?.checkedAt === "number" ? c : undefined;
  } catch { return undefined; }
}

/** Merge into the cache: written to a temp file and renamed (atomic), mode 600. An unwritable cache only costs a repeat check. */
function writeCheckCache(patch: Partial<CheckCache>): void {
  const file = cacheFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify({ ...readCheckCache(), ...patch }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { rmSync(tmp, { force: true }); }
}

/**
 * The latest release, from the cache when it is under a day old, else one GET (4 s timeout). A cached failure is thrown
 * again with its cause rather than retried, so nothing loops. `force` (an explicit command) always asks GitHub.
 */
export async function checkRelease(o: { force?: boolean; now?: number; slug?: string } = {}): Promise<Release> {
  const now = o.now ?? Date.now();
  const cached = readCheckCache();
  if (!o.force && cached && cached.checkedAt <= now && now - cached.checkedAt < DAY_MS) {
    if (cached.error) throw new UpdateError(`last check failed: ${cached.error}`);
    if (cached.version && STABLE.test(cached.version)) return { tag: `v${cached.version}`, version: cached.version, notes: cached.notes ?? "", url: "" };
  }
  try {
    const rel = await latestRelease(o.slug ?? repoSlug());
    writeCheckCache({ checkedAt: now, version: rel.version, notes: rel.notes.slice(0, 600), error: undefined });
    return rel;
  } catch (e) {
    writeCheckCache({ checkedAt: now, error: (e as Error).message, version: undefined, notes: undefined });
    throw e;
  }
}

const truthy = (v?: string) => /^(1|true|yes)$/i.test(v ?? "");
/** Agent hosts mark the shells they run; a notice there would only reach a model. */
const AGENT_ENV = ["CLAUDECODE", "CODEX_SANDBOX", "GEMINI_CLI"];

export function checksEnabled(cfg: Pick<CarlConfig, "update">, env = process.env): boolean {
  return cfg.update.check && !truthy(env.CARL_OFFLINE) && !truthy(env.CARL_NO_UPDATE_CHECK);
}

/** The terminal notice: checks on, stdout and stderr both a TTY, not CI, not an agent session. */
export function noticesEnabled(cfg: Pick<CarlConfig, "update">, env = process.env, tty = !!(process.stdout.isTTY && process.stderr.isTTY)): boolean {
  if (!tty || !checksEnabled(cfg, env)) return false;
  if (env.CI && !/^(0|false)$/i.test(env.CI)) return false;
  return !AGENT_ENV.some((k) => env[k]);
}

export function noticeText(version: string, o: { auto?: boolean; dim?: boolean } = {}): string {
  const first = `carl ${version} available (you have ${VERSION}) · run: carl update`;
  if (o.auto) return first; // the gateway installs it; nothing to turn on
  const second = "turn on automatic updates: carl update --auto on · skip: carl update --skip";
  return `${first}\n${o.dim ? `\x1b[2m${second}\x1b[0m` : second}`;
}

/** Commands that print their own update state, run for long, or print only a version. */
const NO_NOTICE = new Set(["update", "gateway", "help", "--help", "-h", "version", "--version"]);

/**
 * The notice to print on stderr after a command, or undefined: at most once a day per version, never for a skipped
 * version, never with --json. cli-main starts this with the command, so the check never delays its start. Never throws:
 * a failure stays in the cache for `carl update --check`.
 */
export async function commandNotice(args: string[], env = process.env, tty?: boolean, load: () => Pick<CarlConfig, "home" | "update"> = loadConfig): Promise<string | undefined> {
  try {
    if (!args[0] || NO_NOTICE.has(args[0]) || args.includes("--json")) return undefined;
    const cfg = load();
    if (!noticesEnabled(cfg, env, tty)) return undefined;
    const rel = await checkRelease();
    if (!isNewer(rel.version, VERSION) || readState(cfg.home).skipped === rel.version) return undefined;
    const c = readCheckCache();
    if (c?.shown === rel.version && c.shownAt !== undefined && Date.now() - c.shownAt < DAY_MS) return undefined;
    writeCheckCache({ shown: rel.version, shownAt: Date.now() });
    return noticeText(rel.version, { auto: cfg.update.auto, dim: !env.NO_COLOR });
  } catch { return undefined; }
}

// ---- settings --------------------------------------------------------------------------------------------------

/** Set `update.<key>` in carl.json, rewritten from its parsed JSON (every other key kept), atomically, mode 600. */
export function setUpdateConfig(home: string, key: "check" | "auto", on: boolean): void {
  const file = join(home, "carl.json");
  let raw: Record<string, any> = {};
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new UpdateError(`${file} is not valid JSON: ${(e as Error).message}`); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UpdateError(`${file} must hold a JSON object`);
  }
  const update = raw.update && typeof raw.update === "object" && !Array.isArray(raw.update) ? raw.update : {};
  raw.update = { ...update, [key]: on };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

export function readAutoConfig(home: string): boolean {
  const file = join(home, "carl.json");
  return existsSync(file) && JSON.parse(readFileSync(file, "utf8"))?.update?.auto === true;
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
    env: { ...process.env, PATH: `${dirname(realpathSync(process.execPath))}:${process.env.PATH ?? "/usr/bin:/bin"}`, DO_NOT_TRACK: "1", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" } });
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

/** The release's published `carl.tar.gz` (scripts/build-release.sh), checked against its `SHA256SUMS` before anything is unpacked. */
async function downloadBundle(rel: Release, slug: string): Promise<Buffer> {
  const get = async (name: string, timeoutMs: number) => {
    const res = await fetch(`${downloadBase()}/${slug}/releases/download/${encodeURIComponent(rel.tag)}/${name}`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new UpdateError(`cannot download ${name} of ${rel.tag} (HTTP ${res.status}); nothing was switched`);
    return Buffer.from(await res.arrayBuffer());
  };
  const sums = (await get("SHA256SUMS", 15_000)).toString("utf8");
  const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, "") === "carl.tar.gz")?.[0]?.toLowerCase();
  if (!want || !/^[0-9a-f]{64}$/.test(want)) throw new UpdateError(`SHA256SUMS of ${rel.tag} has no carl.tar.gz entry; nothing was switched`);
  const bytes = await get("carl.tar.gz", 300_000);
  if (createHash("sha256").update(bytes).digest("hex") !== want) throw new UpdateError(`checksum mismatch for carl.tar.gz of ${rel.tag}; nothing was switched`);
  return bytes;
}

export async function install(rel: Release, inst: Install, slug = repoSlug(inst.root)): Promise<Installed> {
  if (inst.kind === "other") throw new UpdateError(`cannot update in place: ${inst.why}. Reinstall from https://github.com/${slug}`);
  if (inst.kind === "git") {
    const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], inst.root).trim();
    if (dirty) throw new UpdateError(`${inst.root} has local changes; commit or stash them, then run carl update again`);
    run("git", ["fetch", "--quiet", "--force", "--tags", "origin"], inst.root, 120_000);
    try {
      run("git", ["merge", "--ff-only", "--quiet", `refs/tags/${rel.tag}`], inst.root);
    } catch (e) {
      const msg = (e as Error).message;
      if (/not possible to fast-forward|unrelated histories|non-fast-forward/i.test(msg)) {
        const q = (s: string) => (/[^A-Za-z0-9_./:@+-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);
        const dir = q(inst.root);
        throw new UpdateError(
          `cannot fast-forward ${inst.root} to ${rel.tag} (upstream history diverged or was rewritten). ` +
          `If you have no local commits to keep, recover with: git -C ${dir} fetch --force --tags origin && git -C ${dir} reset --hard ${q(rel.tag)} && npm --prefix ${dir} ci --omit=dev`,
        );
      }
      throw e;
    }
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
    // The shared release must carry this install's runtime link too: when the first link's install made none, every
    // `carl send` from a clean environment (a host's alert sender) exited 127 with "node: not found", while a gateway
    // started with node on PATH kept running and hid it.
    const node = join(inst.root, "node");
    const shared = join(target, "node");
    if (lstatSync(node, { throwIfNoEntry: false })?.isSymbolicLink() && !lstatSync(shared, { throwIfNoEntry: false })) {
      symlinkSync(readlinkSync(node), shared);
    }
    swapLink(`${inst.link}.previous`, inst.root);
    swapLink(inst.link, target);
    prune(inst.appDir);
    return { from: VERSION, to: rel.version, path: target };
  }
  const bundle = await downloadBundle(rel, slug);
  const incoming = join(inst.appDir, `.incoming-${rel.version}-${randomBytes(4).toString("hex")}`);
  mkdirSync(incoming, { mode: 0o700 });
  try {
    run(["/usr/bin/tar", "/bin/tar"].find((t) => existsSync(t)) ?? "tar", ["-xzf", "-", "-C", incoming], incoming, 120_000, bundle);
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
    rmSync(incoming, { recursive: true, force: true }); // gone on success (renamed) and on any failure
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

const RELEASE_DIR = /^release-\d+\.\d+\.\d+-[0-9a-f]{12}$/;

/** Remove Carl's own release folders that no link uses. Other folders (a host's bundled copies, say) are never touched. */
export function prune(appDir: string): string[] {
  const keep = linkedTargets(appDir);
  const removed: string[] = [];
  for (const name of readdirSync(appDir)) {
    const path = join(appDir, name);
    if (!RELEASE_DIR.test(name)) continue;
    if (lstatSync(path).isSymbolicLink() || keep.has(realpathSync(path))) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Retire the rollback copy once the new version has run (the update recorded in state is this version) or after seven
 * days: the `.previous` link goes, and its release folder too unless another link (a second bot) still uses it.
 * Never throws: a cleanup problem must not stop the gateway or an update.
 */
export function cleanupPrevious(home: string, inst: Install = detectInstall(), now = Date.now()): string[] {
  if (inst.kind !== "release") return [];
  try {
    const s = readState(home);
    if (s.installed?.to !== VERSION && !(s.previousAt && now - s.previousAt > 7 * DAY_MS)) return [];
    const prev = `${inst.link}.previous`;
    if (!lstatSync(prev, { throwIfNoEntry: false })?.isSymbolicLink()) return [];
    const target = existsSync(prev) ? realpathSync(prev) : undefined; // a dangling link is debris too
    const appDir = realpathSync(inst.appDir);
    if (target && (dirname(target) !== appDir || !RELEASE_DIR.test(basename(target)) || target === inst.root)) return [];
    rmSync(prev, { force: true });
    writeState(home, { previousAt: undefined });
    if (!target || linkedTargets(appDir).has(target)) return [];
    rmSync(target, { recursive: true, force: true });
    return [basename(target)];
  } catch { return []; }
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

interface State {
  checkedAt?: number;      // any check, CLI or gateway (informational)
  nextGatewayCheckAt?: number; // gateway-owned: only UpdatePlugin moves this deadline
  latest?: string;
  notified?: string;       // the home-chat notice: last version shown, and when
  notifiedAt?: number;
  skipped?: string;        // this version's notices are hidden; a newer version notifies again
  autoOfferDeclined?: boolean; // "Install future updates automatically?" was answered no (or auto turned off): never ask again
  previousAt?: number;     // when the rollback link was made, for the seven-day bound
  installed?: { from: string; to: string; at: number };
  error?: string;
}
const stateFile = (home: string) => join(home, "state", "update.json");
export function readState(home: string): State {
  try { return JSON.parse(readFileSync(stateFile(home), "utf8")); } catch { return {}; }
}
export function writeState(home: string, patch: Partial<State>): void {
  const next = { ...readState(home), ...patch };
  mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(home) + ".tmp", JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(stateFile(home) + ".tmp", stateFile(home));
}

/** The newer version the last check saw, if any and not skipped (for `carl status`, /status and the web app). */
export function availableUpdate(home: string): string | undefined {
  const s = readState(home);
  return s.latest && s.latest !== s.skipped && isNewer(s.latest, VERSION) ? s.latest : undefined;
}

export function skipVersion(home: string, version: string): void {
  writeState(home, { skipped: version });
}

const AUTO_LOG_MAX = 256 * 1024;

/** The background-install log: one file, newest whole lines kept, never over 256 KB. */
export function autoLog(home: string, level: string, msg: string, data: Record<string, unknown> = {}): void {
  try {
    const file = join(home, "logs", "auto-update.log");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const cap = (_k: string, v: unknown) => (typeof v === "string" && v.length > 2_000 ? `${v.slice(0, 2_000)}…` : v);
    const line = Buffer.from(JSON.stringify({ at: new Date().toISOString(), level, msg, ...data }, cap) + "\n");
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size + line.length <= AUTO_LOG_MAX) return appendFileSync(file, line, { mode: 0o600 });
    const old = readFileSync(file);
    const tail = old.subarray(old.length - (AUTO_LOG_MAX - line.length));
    writeFileSync(`${file}.tmp`, Buffer.concat([tail.subarray(tail.indexOf(10) + 1), line]), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch {} // a full or read-only disk must never stop the gateway
}

/** First version whose gateway restarts itself on SIGUSR2; an older one would simply be killed by the signal. */
const RESTARTS_ON_SIGNAL = "0.10.0";

/** Ask the gateway on this home to restart on the installed code once it is idle. */
function signalGateway(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, "state", "gateway.pid"), "utf8").trim());
    if (!pid) return undefined;
    const running = String(JSON.parse(readFileSync(join(home, "state", "status.json"), "utf8")).version ?? "");
    if (!STABLE.test(running) || isNewer(RESTARTS_ON_SIGNAL, running)) return undefined;
    const cmd = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 }).stdout ?? "";
    if (!/main\.ts gateway/.test(cmd)) return undefined;
    process.kill(pid, "SIGUSR2");
    return pid;
  } catch { return undefined; }
}

/** The version a live gateway on this home runs, if one does. */
function liveGatewayVersion(home: string): string | undefined {
  try {
    const s = JSON.parse(readFileSync(join(home, "state", "status.json"), "utf8"));
    if (s.state !== "running" || !s.pid) return undefined;
    process.kill(Number(s.pid), 0);
    return String(s.version ?? "");
  } catch { return undefined; }
}

// ---- CLI ---------------------------------------------------------------------------------------------------

/** Terminal I/O, injectable so tests drive the same decisions without a terminal. */
export interface UpdateIO {
  interactive?: boolean;
  ask?: (question: string, defaultYes: boolean) => Promise<boolean>;
  installer?: (rel: Release, inst: Install, slug: string) => Promise<Installed>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer ? /^(y|yes)$/.test(answer) : defaultYes;
  } finally { rl.close(); }
}

export async function updateCommand(args: string[], io: UpdateIO = {}): Promise<number> {
  const home = carlHome();
  const out = io.out ?? ((s: string) => console.log(s));
  const err = io.err ?? ((s: string) => console.error(s));
  const interactive = io.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  const ask = io.ask ?? askYesNo;
  const checkOnly = args.includes("--check");
  const refresh = args.includes("--refresh");
  try {
    if (args.includes("--auto")) {
      const value = args[args.indexOf("--auto") + 1];
      if (value === "status") {
        out(`automatic updates: ${readAutoConfig(home) ? "on" : "off"}`);
        return 0;
      }
      if (value !== "on" && value !== "off") {
        err("carl update: --auto needs on, off or status");
        return 64;
      }
      setUpdateConfig(home, "auto", value === "on");
      if (value === "off") {
        writeState(home, { autoOfferDeclined: true }); // an explicit "off" answers the post-install question too
        rmSync(cacheFile(), { force: true });          // the one update file outside CARL_HOME
      }
      out(`automatic updates: ${value}`);
      return 0;
    }
    if (args.includes("--skip")) {
      const rel = await checkRelease({ force: refresh });
      if (!isNewer(rel.version, VERSION)) {
        out(`Carl ${VERSION} is up to date; nothing to skip.`);
        return 0;
      }
      skipVersion(home, rel.version);
      out(`Skipped Carl ${rel.version}. A newer release will show again.`);
      return 0;
    }
    const inst = detectInstall();
    if (args.includes("--rollback")) {
      const to = rollback(inst);
      out(`Rolled back to ${basename(to)}.`);
      const pid = signalGateway(home);
      if (pid) out(`The gateway (pid ${pid}) restarts on it once nothing is running.`);
      return 0;
    }
    // Retire the rollback copy once this version has run, unless a gateway here still runs the old code.
    const gateway = liveGatewayVersion(home);
    if (!gateway || gateway === VERSION) cleanupPrevious(home, inst);
    const rel = await checkRelease({ force: !checkOnly || refresh });
    writeState(home, { checkedAt: Date.now(), latest: rel.version, error: undefined });
    if (!isNewer(rel.version, VERSION)) {
      out(`Carl ${VERSION} is up to date.`);
      return 0;
    }
    out(`Carl ${VERSION} → ${rel.version}`);
    out(summary(rel.notes));
    if (rel.url) out(rel.url);
    if (checkOnly) return 10;
    if (interactive && !(await ask(`Install ${rel.version} now? [Y/n] `, true))) {
      out("Not installed.");
      return 0;
    }
    out(inst.kind === "release" ? `Installing beside ${inst.root} ...` : `Updating ${inst.root} ...`);
    const done = await (io.installer ?? install)(rel, inst, repoSlug(inst.root));
    writeState(home, { installed: { from: done.from, to: done.to, at: Date.now() }, previousAt: inst.kind === "release" ? Date.now() : undefined });
    out(`Installed Carl ${done.to} (${done.path}).${inst.kind === "release" ? " Undo with: carl update --rollback" : ""}`);
    const pid = signalGateway(home);
    out(pid ? `The gateway (pid ${pid}) restarts on ${done.to} once nothing is running.` : "Start or restart the gateway to run it.");
    // Asked once, on a TTY, after a successful install; "no" is remembered.
    if (interactive && !readAutoConfig(home) && !readState(home).autoOfferDeclined) {
      if (await ask("Install future updates automatically? [y/N] ", false)) {
        setUpdateConfig(home, "auto", true);
        out("Automatic updates are on.");
      } else writeState(home, { autoOfferDeclined: true });
    }
    return 0;
  } catch (e) {
    const cause = (e as Error).message;
    try { writeState(home, { checkedAt: Date.now(), error: cause }); } catch {}
    err(`carl update: ${cause}`);
    if (checkOnly && !refresh && cause.startsWith("last check failed")) err("Check again now: carl update --check --refresh");
    return 1;
  }
}

// ---- gateway plugin ----------------------------------------------------------------------------------------

/** Injectable clock so the daily gateway check can be driven deterministically in tests. */
export interface UpdateClock {
  now(): number;
  after(fn: () => void, ms: number): NodeJS.Timeout;
}
const SYSTEM_CLOCK: UpdateClock = { now: () => Date.now(), after: (fn, ms) => setTimeout(fn, ms) };

/** A busy gateway rechecks soon instead of installing under active runs, or waiting a whole day. */
const BUSY_RETRY_MS = 10 * 60_000;

/** The actions behind /update, the notice's buttons and the web app's Updates section. */
export interface UpdateControls {
  check(): Promise<string>;
  install(): Promise<string>;
  skip(): string;
  setAuto(on: boolean): string;
  setCheck(on: boolean): string;
}

/**
 * In the gateway: a daily check that tells the home chat once a day per new version (with Update now / Skip buttons),
 * the /update command, optional automatic install (`update.auto`), and an "updated" note after the restart. The check
 * keeps its own deadline in state: `carl update --check`, /update and restarts only touch `checkedAt`, never the deadline.
 */
export class UpdatePlugin implements GatewayPlugin {
  readonly name = "update";
  private timer?: NodeJS.Timeout;
  private gw?: Gateway;
  private installing = false;
  private latest?: Release;
  private readonly clock: UpdateClock;

  constructor(clock: UpdateClock = SYSTEM_CLOCK) { this.clock = clock; }

  start(gw: Gateway): void {
    this.gw = gw;
    const home = gw.cfg.home;
    gw.telegram?.commands.set("update", { help: "Check, install or skip a Carl release; /update auto on|off", run: (args) => this.command(args) });
    gw.telegram?.callbacks.set("upd", (q, data) => this.button(q, data));
    gw.updates = {
      check: async () => {
        const rel = await this.refresh();
        return isNewer(rel.version, VERSION) ? `Carl ${rel.version} is available — you have ${VERSION}.` : `Carl ${VERSION} is up to date.`;
      },
      install: () => this.installLatest(),
      skip: () => this.skip(),
      setAuto: (on) => this.setAuto(on),
      setCheck: (on) => this.setCheck(on),
    };
    const s = readState(home);
    cleanupPrevious(home); // this version now runs (or seven days passed): the rollback copy goes
    if (s.installed && s.installed.to === VERSION) {
      writeState(home, { installed: undefined });
      autoLog(home, "info", "update running", { version: VERSION });
      setTimeout(() => this.tell(`Carl updated: ${s.installed!.from} → ${VERSION}.`), 5_000).unref();
    }
    if (!checksEnabled(gw.cfg)) {
      if (gw.cfg.update.auto) gw.log.info("auto-update skipped", { reason: "checks disabled" });
      return;
    }
    this.schedule(Math.max(60_000, (s.nextGatewayCheckAt ?? 0) - this.clock.now()));
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  /** Persist the gateway's own next-check deadline before arming the timer, so a restart resumes it. */
  private schedule(ms: number): void {
    const gw = this.gw!;
    writeState(gw.cfg.home, { nextGatewayCheckAt: this.clock.now() + ms });
    this.timer = this.clock.after(() => void this.tick(), ms);
    this.timer.unref();
  }

  private tell(text: string): void {
    const gw = this.gw!;
    if (!gw.telegram || !gw.cfg.telegram.homeChat) return void gw.log.info("update notice (no Telegram home chat)", { text });
    void gw.send("home", text).catch((e) => gw.log.warn("update notice not delivered", { error: (e as Error).message }));
  }

  /** The home-chat notice, once a day per version: the release notes with Update now / Skip buttons (commands as a fallback). */
  private notify(rel: Release, lead = ""): void {
    const gw = this.gw!;
    const s = readState(gw.cfg.home);
    if (s.notified === rel.version && s.notifiedAt && this.clock.now() - s.notifiedAt < DAY_MS) return;
    writeState(gw.cfg.home, { notified: rel.version, notifiedAt: this.clock.now() });
    const text = `${lead ? `${lead}\n\n` : ""}Carl ${rel.version} is available — you have ${VERSION}.\n\n${summary(rel.notes)}`;
    const chat = gw.cfg.telegram.homeChat;
    if (!gw.telegram || !chat) return this.tell(text);
    const buttons = [[{ text: "Update now", callback_data: `upd:install:${rel.version}` }, { text: "Skip this version", callback_data: `upd:skip:${rel.version}` }]];
    if (!gw.cfg.update.auto) buttons.push([{ text: "Turn on automatic updates", callback_data: `upd:auto:${rel.version}` }]);
    void gw.telegram.sendMarkdown(chat, text, { buttons }).catch((e) => {
      gw.log.warn("update buttons not delivered; sending the commands instead", { error: (e as Error).message });
      this.tell(`${text}\n\n/update installs it · /update skip hides this version · /update auto on installs future ones automatically`);
    });
  }

  /** An explicit check (/update, Check Now): always one fresh request. */
  private async refresh(): Promise<Release> {
    const rel = await checkRelease({ force: true });
    this.latest = rel;
    writeState(this.gw!.cfg.home, { checkedAt: this.clock.now(), latest: rel.version, error: undefined });
    return rel;
  }

  private skip(version = this.latest?.version ?? readState(this.gw!.cfg.home).latest): string {
    if (!version || !isNewer(version, VERSION)) return `Carl ${VERSION} is up to date; nothing to skip.`;
    skipVersion(this.gw!.cfg.home, version);
    return `Skipped Carl ${version}. A newer release will show again.`;
  }

  private setAuto(on: boolean): string {
    setUpdateConfig(this.gw!.cfg.home, "auto", on);
    this.gw!.cfg.update.auto = on;
    return `Automatic updates are ${on ? "on" : "off"}.`;
  }

  private setCheck(on: boolean): string {
    const gw = this.gw!;
    setUpdateConfig(gw.cfg.home, "check", on);
    gw.cfg.update.check = on;
    this.stop();
    if (checksEnabled(gw.cfg)) this.schedule(60_000);
    return `Update checks are ${on ? "on" : "off"}.`;
  }

  private async installLatest(): Promise<string> {
    const rel = this.latest && isNewer(this.latest.version, VERSION) ? this.latest : await this.refresh();
    return isNewer(rel.version, VERSION) ? (await this.apply(rel)).text : `Carl ${VERSION} is up to date.`;
  }

  /** A button press: only the home chat's allowed users reach this (TelegramChannel.onCallback enforces allowFrom). */
  private async button(q: import("./channels/telegram-api.ts").TgCallbackQuery, data: string): Promise<string> {
    const [, action, version] = data.split(":");
    const tg = this.gw!.telegram;
    if (q.message && tg) { // one answer per notice: the buttons go
      void tg.api.call("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }, { retries: 0 }).catch(() => {});
    }
    if (action === "skip") return this.skip(version);
    if (action === "auto") return this.setAuto(true);
    if (action === "install") return this.installLatest();
    return "This button is no longer handled.";
  }

  private async tick(): Promise<void> {
    const gw = this.gw!;
    this.timer = undefined;
    if (!checksEnabled(gw.cfg)) return; // turned off since start; setCheck(true) arms the timer again
    let delay = DAY_MS;
    try {
      const rel = await checkRelease();
      this.latest = rel;
      writeState(gw.cfg.home, { checkedAt: this.clock.now(), latest: rel.version, error: undefined });
      if (!isNewer(rel.version, VERSION)) {
        if (gw.cfg.update.auto) gw.log.info("auto-update skipped", { reason: "already current", version: rel.version });
      } else if (readState(gw.cfg.home).skipped === rel.version) {
        gw.log.info("update notice skipped", { reason: "version skipped", version: rel.version });
      } else if (!gw.cfg.update.auto) {
        this.notify(rel);
      } else {
        // Auto-install must not depend on `checkedAt` or `notified`: either can come from a CLI check or a failed
        // earlier attempt. `installed` is written only after a real install, and the child signals the gateway to
        // restart on the new code once nothing is running.
        const s = readState(gw.cfg.home);
        if (gw.brain.busyCount() > 0 || gw.scheduler.runningCount() > 0) {
          gw.log.info("auto-update skipped", { reason: "runs active", version: rel.version });
          delay = BUSY_RETRY_MS;
        } else if (s.installed?.to === rel.version) {
          gw.log.info("auto-update skipped", { reason: "installed, waiting for restart", version: rel.version });
        } else {
          const r = await this.apply(rel);
          if (!r.ok) this.notify(rel, r.text); // a failed auto-install falls back to the notice
        }
      }
    } catch (e) {
      gw.log.warn("update check failed", { error: (e as Error).message });
      writeState(gw.cfg.home, { checkedAt: this.clock.now(), error: (e as Error).message });
    }
    this.schedule(delay);
  }

  /**
   * Install through `carl update` in a low-priority child process: npm runs there, so the gateway keeps answering
   * meanwhile. The child signals this gateway (SIGUSR2), which restarts on the new code once nothing is running.
   */
  private async apply(rel: Release): Promise<{ ok: boolean; text: string }> {
    if (this.installing) return { ok: true, text: "An update is already being installed." };
    this.installing = true;
    const gw = this.gw!;
    autoLog(gw.cfg.home, "info", "install started", { version: rel.version });
    try {
      const entry = process.env.CARL_ENTRY;
      const argv = entry ? ["/bin/sh", entry, "update"] : [process.execPath, "--experimental-strip-types", "--no-warnings", join(ROOT, "src", "main.ts"), "update"];
      const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, CARL_HOME: gw.cfg.home }, stdio: ["ignore", "pipe", "pipe"] });
      try { if (child.pid) setPriority(child.pid, 10); } catch {}
      let out = "";
      child.stdout.on("data", (d) => (out = (out + d).slice(-8_000)));
      child.stderr.on("data", (d) => (out = (out + d).slice(-8_000)));
      const code = await new Promise<number>((ok) => { child.on("error", (e) => { out += e.message; ok(1); }); child.on("close", (c) => ok(c ?? 1)); });
      const tail = out.trim().split("\n").slice(-3).join("\n");
      if (code !== 0) throw new UpdateError(tail || `carl update exited ${code}`);
      gw.log.info("update installed", { to: rel.version });
      autoLog(gw.cfg.home, "info", "install succeeded", { version: rel.version });
      return { ok: true, text: `${tail}\n\nCarl restarts on ${rel.version} once nothing is running.` };
    } catch (e) {
      const cause = (e as Error).message;
      gw.log.error("update failed", { error: cause });
      autoLog(gw.cfg.home, "error", "install failed", { version: rel.version, error: cause });
      writeState(gw.cfg.home, { error: cause });
      return { ok: false, text: `Update to ${rel.version} failed: ${cause}\nCarl keeps running ${VERSION}.` };
    } finally {
      this.installing = false;
    }
  }

  private async command(args: string): Promise<string> {
    const [verb, value] = args.trim().toLowerCase().split(/\s+/);
    if (verb === "auto") {
      if (value === "on" || value === "off") return this.setAuto(value === "on");
      return `Automatic updates are ${this.gw!.cfg.update.auto ? "on" : "off"}. Send /update auto on or /update auto off.`;
    }
    if (verb === "skip") return this.skip();
    const rel = await this.refresh();
    if (!isNewer(rel.version, VERSION)) return `Carl ${VERSION} is up to date.`;
    if (verb === "check") return `Carl ${rel.version} is available — you have ${VERSION}.\n\n${summary(rel.notes)}\n\nSend /update to install it.`;
    return (await this.apply(rel)).text;
  }
}

function summary(notes: string): string {
  const lines = notes.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6).join("\n");
  return lines.length > 900 ? lines.slice(0, 900) + "…" : lines || "(no release notes)";
}
