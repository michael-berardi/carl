// Private, redacted Telegram mutation receipts for UltraTerm. Ambiguous outcomes are never proof of delivery.
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, opendirSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { htmlToPlain } from "./channels/format.ts";
import type { TelegramOutcome } from "./channels/telegram-api.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 5;
/** The lock file that keeps two Carl processes from writing the same file at the same time. */
const WRITE_LOCK = "hermes.jsonl.lock";
/** A lock older than this was left behind by a killed process and may be taken over. */
const STALE_LOCK_MS = 5_000;
/** Bot API methods that put a message in a chat (or change/remove one). Everything else (typing, polls) is not a message. */
const MESSAGE_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendAudio",
  "sendDocument",
  "sendVideo",
  "sendVoice",
  "sendAnimation",
  "sendLocation",
  "editMessageText",
  "editMessageCaption",
  "editMessageMedia",
  "editMessageReplyMarkup",
  "deleteMessage",
  "deleteMessages",
  "copyMessage",
  "forwardMessage",
  "copyMessages",
  "forwardMessages",
  "sendMediaGroup",
  "sendSticker",
  "sendPoll",
  "sendVenue",
  "sendContact",
  "sendDice",
]);

export type Warn = (msg: string, data?: Record<string, unknown>) => void;

/**
 * Where the log lives. CARL_MESSAGE_LOG_DIR is a test switch: it points the writer at a scratch folder so tests never
 * touch the operator's real UltraTerm logs on this machine. It says where rows go, not whether they are written.
 * A test that forgets the switch still cannot write into the real log: under Node's test runner the rows go to a
 * scratch folder instead.
 */
export function messageLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CARL_MESSAGE_LOG_DIR?.trim();
  if (override) return override;
  if (env.NODE_TEST_CONTEXT) return join(tmpdir(), `carl-message-log-${process.pid}`, "messages");
  return join(homedir(), ".ultraterm", "logs", "ultrabot-messages");
}

function numericChat(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?[1-9][0-9]*$/.test(value)) return value;
  return undefined;
}

function positiveId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Inline-keyboard labels, so the audit can still see which card a message was. */
function buttonsOf(body: Record<string, unknown>): string[] | null {
  const keyboard = (body.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard;
  if (!Array.isArray(keyboard)) return null;
  const labels = keyboard.flat().map((button) => (button && typeof button === "object" ? (button as { text?: unknown }).text : undefined)).filter((text): text is string => typeof text === "string");
  return labels;
}

/** The row for one delivered call, or nothing when the call is not a message or has no usable identity. */
export function deliveryRow(method: string, body: Record<string, unknown>, result: unknown, at: Date = new Date()): Record<string, unknown> | undefined {
  if (!MESSAGE_METHODS.has(method)) return undefined;
  const chatId = numericChat(body.chat_id);
  if (!chatId) return undefined;
  const sent = result && typeof result === "object" ? (result as { message_id?: unknown }) : undefined;
  // The result carries the id of the message Telegram created; the body only carries the id of a message being
  // changed (an edit or a deletion) or, for a copy or a forward, the id of the source message.
  const single = positiveId(sent?.message_id) ?? (/^(?:edit|delete)/.test(method) ? positiveId(body.message_id) : undefined);
  const many = Array.isArray(result)
    ? result.map((item) => positiveId(item && typeof item === "object" ? item.message_id : undefined))
    : /^delete/.test(method) && Array.isArray(body.message_ids) ? body.message_ids.map(positiveId) : [];
  const messageId = many.length ? many : single;
  if (messageId === undefined || (Array.isArray(messageId) && messageId.some((id) => id === undefined))) return undefined;
  const raw = typeof body.text === "string" ? body.text : typeof body.caption === "string" ? body.caption : null;
  const text = raw === null ? null : body.parse_mode === "HTML" ? htmlToPlain(raw) : raw;
  return {
    v: 1,
    ts: at.toISOString(),
    writer: "hermes",
    gateway: "carl",
    source: "telegram",
    kind: method,
    method,
    chatId,
    messageId,
    text,
    buttons: buttonsOf(body),
    file: typeof body.document === "object" && body.document ? ((body.document as { file_name?: string }).file_name ?? null) : null,
    ok: true,
    error: null,
    job: null,
    alert: null,
    status: "delivered",
  };
}

const secretName = (name: string) => /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(name);

/** Quoted JSON fields (including escaped JSON), assignments, and unterminated values. Keep non-secret prose intact. */
function redactQuotedFields(text: string): string {
  let out = "", copied = 0, at = 0;
  while (at < text.length) {
    const quote = text[at];
    const quoted = quote === '"' || quote === "'";
    let name: string, cursor: number;
    if (quoted) {
      const end = text.indexOf(quote, at + 1);
      if (end < 0) { at++; continue; }
      name = text.slice(at + 1, end).replace(/\\+$/, ""); cursor = end + 1;
    } else if (/[A-Za-z_]/.test(quote) && (at === 0 || !/[A-Za-z0-9_]/.test(text[at - 1]))) {
      cursor = at;
      while (cursor < text.length && /[A-Za-z0-9_]/.test(text[cursor])) cursor++;
      name = text.slice(at, cursor);
    } else { at++; continue; }
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    if (name.length > 64 || /\s/.test(name) || !secretName(name) || !(text[cursor] === "=" || (quoted && text[cursor] === ":"))) { at++; continue; }
    cursor++;
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    let escapes = 0;
    while (text[cursor] === "\\") { escapes++; cursor++; }
    const valueQuote = text[cursor];
    if (valueQuote !== '"' && valueQuote !== "'") { at++; continue; }
    const from = cursor + 1;
    let end = from;
    while (end < text.length) {
      if (text[end] === "\\" && escapes === 0) { end += 2; continue; }
      if (text[end] === valueQuote && (escapes === 0 || text[end - 1] === "\\")) break;
      end++;
    }
    let valueEnd = Math.min(end, text.length);
    while (end < text.length && valueEnd > from && text[valueEnd - 1] === "\\") valueEnd--;
    out += text.slice(copied, from) + "[REDACTED]";
    copied = valueEnd; at = end + 1;
  }
  return out + text.slice(copied);
}

function redactText(text: string): string {
  return redactQuotedFields(text)
    .replace(/\b([A-Za-z_][A-Za-z0-9_]{0,63})([ \t]*=[ \t]*)([^\s"'<>;,]+)/g, (all, name: string, separator: string) => secretName(name) ? `${name}${separator}[REDACTED]` : all)
    // A numeric bot identity plus a long token is distinctive even when directly concatenated with prose.
    .replace(/(?:bot)?\d+:[A-Za-z0-9_-]{20,}/g, "[REDACTED_BOT_TOKEN]")
    // Embedded credentials need a recognizable vendor structure, not merely a word ending in "sk-"/"ghp_".
    .replace(/sk-(?:ant-|proj-|svcacct-)[A-Za-z0-9_-]{10,}|\bsk-[A-Za-z0-9_-]{10,}|sk-(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/(?<![A-Za-z0-9_])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9_])|github_pat_[A-Za-z0-9]{11}_[A-Za-z0-9]{59}(?![A-Za-z0-9_])/g, "[REDACTED_API_KEY]")
    .replace(/(?<![A-Za-z0-9_])(?:xox[bparse]-|xapp-)[A-Za-z0-9_-]{10,}|(?:xox[bparse]-|xapp-)\d+-[A-Za-z0-9_-]{10,}/g, "[REDACTED_API_KEY]")
    .replace(/\b((?:Proxy-)?Authorization:[ \t]*(?:Basic|Bearer|Digest|Token|Negotiate)[ \t]+)[^\s;,'"<>]+/gi, "$1[REDACTED]")
    .replace(/\b((?:Proxy-)?Authorization:[ \t]*)(?!(?:Basic|Bearer|Digest|Token|Negotiate)\b)[^\s;,'"<>]{8,}/gi, "$1[REDACTED]")
    .replace(/\bBearer([ \t]+)[^\s;,'"<>]+/gi, "Bearer$1[REDACTED]");
}

/** Mask every string in the record, not just text (errors, captions, filenames and provenance may contain secrets). */
function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  return value;
}

export type LogOrigin = Partial<Record<"source" | "kind" | "job" | "alert", string | null>>;
// UltraBot receipt/alert labels; arbitrary labels may not override the Bot API method.
const ORIGIN_KINDS = new Set([...MESSAGE_METHODS, "question", "done", "done-incomplete", "correction", "failed", "waiting", "blocked", "priority-fix", "unowned", "stalled", "routine-digest", "digest"]);

/** Called only by `carl send`, never implicitly by a logger or long-running gateway. Invalid fields fall back individually. */
export function sendLogOrigin(env: NodeJS.ProcessEnv = process.env, warn: Warn = () => {}): LogOrigin {
  const origin: LogOrigin = {};
  for (const key of ["source", "kind", "job", "alert"] as const) {
    const name = `ULTRABOT_LOG_${key.toUpperCase()}`;
    const value = env[name];
    if (value === undefined) continue;
    if (!value && (key === "job" || key === "alert")) { origin[key] = null; continue; }
    if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) || (key === "kind" && !ORIGIN_KINDS.has(value))) {
      try { warn(`ignored invalid ${name}: expected a safe label of at most 128 characters${key === "kind" ? " and a known kind" : ""}`); } catch {}
      continue;
    }
    origin[key] = value;
  }
  return origin;
}

function attemptRow(method: string, body: Record<string, unknown>, result: unknown, outcome?: TelegramOutcome, origin: LogOrigin = {}): Record<string, unknown> | undefined {
  if (!MESSAGE_METHODS.has(method)) return undefined;
  const delivered = deliveryRow(method, body, result);
  const raw = typeof body.text === "string" ? body.text : typeof body.caption === "string" ? body.caption : null;
  const isEdit = /^(?:edit|delete)/.test(method);
  const status = outcome?.status ?? "delivered";
  const row: Record<string, unknown> = {
    v: 1, ts: new Date().toISOString(), writer: "hermes", gateway: "carl", source: "telegram", kind: method, method,
    chatId: numericChat(body.chat_id) ?? null,
    messageId: isEdit ? positiveId(body.message_id) ?? null : null,
    text: raw === null ? null : body.parse_mode === "HTML" ? htmlToPlain(raw) : raw,
    buttons: buttonsOf(body), file: typeof body.document === "object" && body.document ? (body.document as { file_name?: string }).file_name ?? null : null,
    job: null, alert: null, ...delivered,
    requestId: outcome?.requestId ?? randomUUID(), status,
    ok: status === "delivered" ? true : status === "unknown" ? null : false,
    error: outcome?.error ?? null,
  };
  // Only an explicitly supplied CLI envelope may replace default provenance.
  Object.assign(row, origin);
  const cleaned = redact(row) as Record<string, unknown>;
  const masked = JSON.stringify(row) !== JSON.stringify(cleaned);
  return { ...cleaned, masked, exact: !masked };
}

const uid = () => process.getuid?.();
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
function info(path: string): Stats | undefined { try { return lstatSync(path); } catch (e) { if (missing(e)) return; throw e; } }
function same(a: Stats, b: Stats): boolean { return a.ino === b.ino && a.dev === b.dev; }
function regular(st: Stats): void {
  if (!st.isFile() || st.nlink !== 1 || (uid() !== undefined && st.uid !== uid())) throw new Error("log path is not a single-link owned regular file");
}

/** Validate before and after a nonblocking no-follow open; all chmod/truncation/writes use this descriptor. */
function safeOpen(path: string, flags: number, create = false): number {
  const before = info(path);
  if (before) regular(before);
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error("safe log opens are unsupported on this platform");
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0), 0o600);
  try {
    const st = fstatSync(fd);
    regular(st);
    const after = info(path);
    if (!after || !same(st, after) || (before && !same(st, before))) throw new Error("log file changed during open");
    if (st.mode & 0o077) fchmodSync(fd, 0o600);
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}
function smallRead(path: string): string {
  const fd = safeOpen(path, constants.O_RDONLY);
  try {
    if (fstatSync(fd).size > 256) throw new Error("oversized log sidecar");
    const bytes = Buffer.alloc(257);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n > 256) throw new Error("oversized log sidecar");
    return bytes.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}

/** Refuse user-controlled symlink directories, including ancestors, before mkdir or chmod can follow them. */
function privateDirectory(path: string): void {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  let current = parse(absolute).root;
  const components = absolute.slice(current.length).split("/").filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let st = info(current);
    // macOS exposes its system temporary directories through root-owned /var and /tmp aliases.
    if (st?.isSymbolicLink() && st.uid === 0 && (current === "/var" || current === "/tmp")) {
      const actual = realpathSync(current);
      if (actual !== `/private${current}`) throw new Error("unexpected system directory alias");
      current = actual;
      st = info(current);
    }
    if (!st) { mkdirSync(current, { mode: 0o700 }); st = lstatSync(current); }
    if (!st.isDirectory() || (st.uid !== 0 && st.uid !== uid())) throw new Error("unsafe log directory");
    if (index === components.length - 2) {
      if (st.uid !== uid() || st.mode & 0o022) throw new Error("log immediate parent must be owned and owner-only writable");
    } else if (current !== absolute && st.mode & 0o022 && st.uid !== uid() && !(st.uid === 0 && st.mode & 0o1000)) {
      throw new Error("writable unowned log ancestor");
    }
  }
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.uid !== uid() || parentStat.mode & 0o022) throw new Error("log immediate parent must be owned and owner-only writable");
  const st = lstatSync(absolute);
  if (!st.isDirectory() || (uid() !== undefined && st.uid !== uid())) throw new Error("log directory is not owned");
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY);
  try {
    if (!same(st, fstatSync(fd))) throw new Error("log directory changed during open");
    if (st.mode & 0o077) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

function processStart(pid: number): string | undefined {
  try {
    const value = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000, maxBuffer: 1_024, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim();
    return value || undefined;
  } catch { return undefined; }
}
let ownStart: string | undefined;
function lockToken(): string {
  ownStart ??= processStart(process.pid);
  return JSON.stringify({ pid: process.pid, start: ownStart, at: Date.now(), nonce: randomUUID() });
}

/** One private append-only writer shared by the gateway and `carl send`. Logging never changes send results. */
export class MessageLog {
  private readonly directory: string;
  private readonly warn: Warn;
  private reported = false;
  private token?: string;
  private pending = 0;
  private readonly origin: LogOrigin;

  constructor(directory = messageLogDir(), warn: Warn = () => {}, origin: LogOrigin = {}) { this.directory = directory; this.warn = warn; this.origin = { ...origin }; }
  get file(): string { return join(this.directory, "hermes.jsonl"); }

  record(method: string, body: Record<string, unknown>, result: unknown, outcome?: TelegramOutcome): void {
    if (!MESSAGE_METHODS.has(method)) return;
    let locked = false;
    try {
      const row = attemptRow(method, body, result, outcome, this.origin)!;
      privateDirectory(this.directory);
      locked = this.takeWriteLock();
      if (!locked) throw new Error("message log writer is contended");
      this.rotate();
      const losses = this.losses();
      if (losses.count || this.pending) row.writeErrors = losses.count + this.pending;
      if (losses.unacknowledged) row.errorCounterUnacknowledged = true;
      const fd = safeOpen(this.file, constants.O_RDWR | constants.O_APPEND, true);
      try {
        this.repairTail(fd, row);
        const before = fstatSync(fd).size;
        try {
          const line = Buffer.from(JSON.stringify(row) + "\n");
          if (writeSync(fd, line) !== line.length) throw new Error("short log append");
          fsyncSync(fd);
        } catch (e) { ftruncateSync(fd, before); throw e; }
      } finally { closeSync(fd); }
      this.pending = 0;
      this.acknowledge(losses);
      this.reported = false;
    } catch (e) {
      this.pending++;
      this.countLoss();
      this.problem(`message log write failed: ${(e as Error).message}`);
    } finally { if (locked) this.releaseWriteLock(); }
  }

  private repairTail(fd: number, row: Record<string, unknown>): void {
    const size = fstatSync(fd).size;
    if (!size) return;
    const tail = Buffer.alloc(Math.min(size, 64 * 1024));
    if (readSync(fd, tail, 0, tail.length, size - tail.length) !== tail.length) throw new Error("short log tail read");
    if (tail[tail.length - 1] === 10) return;
    const start = tail.lastIndexOf(10) + 1;
    if (!start && size > tail.length) throw new Error("log tail exceeds recovery bound");
    let valid = false;
    try { JSON.parse(tail.subarray(start).toString("utf8")); valid = true; } catch {}
    if (valid) {
      if (writeSync(fd, "\n") !== 1) throw new Error("short log newline repair");
    } else { ftruncateSync(fd, size - tail.length + start); row.recoveredFragments = 1; }
  }

  /** Preflight *all* rotation paths; a planted destination must not be overwritten or chmodded through. */
  private rotate(): void {
    const seen = new Map<string, Stats>();
    for (let n = 0; n <= KEEP; n++) {
      const path = n ? `${this.file}.${n}` : this.file;
      if (!info(path)) continue;
      const fd = safeOpen(path, constants.O_RDONLY);
      try { seen.set(path, fstatSync(fd)); } finally { closeSync(fd); }
    }
    if ((seen.get(this.file)?.size ?? 0) < MAX_BYTES) return;
    for (let n = KEEP - 1; n >= 0; n--) {
      const from = n ? `${this.file}.${n}` : this.file;
      const to = `${this.file}.${n + 1}`;
      const st = seen.get(from);
      if (!st) continue;
      if (!same(st, lstatSync(from))) throw new Error("rotation source changed");
      const dest = info(to);
      if (dest) regular(dest);
      renameSync(from, to);
    }
  }

  private takeWriteLock(): boolean {
    const lock = join(this.directory, WRITE_LOCK);
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd: number;
      try { fd = safeOpen(lock, constants.O_WRONLY | constants.O_EXCL, true); }
      catch (e) {
        if (missing(e)) continue;
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
        if (!this.takeOverStaleLock(lock)) return false;
        this.pending++; // A crashed/reused writer may have lost its receipt; preserve conservative loss evidence.
        continue;
      }
      const token = lockToken();
      try { writeSync(fd, token); this.token = token; return true; }
      finally { closeSync(fd); }
    }
    return false;
  }

  private takeOverStaleLock(lock: string): boolean {
    try {
      const seen = lstatSync(lock);
      regular(seen);
      if (Date.now() - seen.mtimeMs <= STALE_LOCK_MS) return false;
      const text = smallRead(lock);
      let owner: { pid?: number; start?: string; at?: number };
      try { owner = JSON.parse(text); } catch {
        const legacy = text.match(/^(\d+)-(\d+)-/);
        owner = { pid: Number(legacy?.[1] ?? text.match(/^(\d+)-/)?.[1]), at: Number(legacy?.[2]) };
      }
      const pid = owner?.pid;
      if (Number.isSafeInteger(pid) && pid! > 0) {
        try {
          try { process.kill(pid!, 0); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e; }
          const actual = processStart(pid!);
          // If process identity cannot be checked, keep the live lock. Legacy locks recorded acquisition time:
          // a process born later cannot own one, but an earlier birth is not evidence of reuse.
          if (!actual || (typeof owner.start === "string" ? owner.start === actual : !(Number.isFinite(owner.at) && Date.parse(actual) > owner.at!))) return false;
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") return false; }
      }
      const stale = `${lock}.stale-${randomUUID()}`;
      renameSync(lock, stale);
      const moved = lstatSync(stale);
      if (!same(moved, seen) || Date.now() - moved.mtimeMs <= STALE_LOCK_MS) {
        if (!info(lock)) renameSync(stale, lock);
        return false;
      }
      unlinkSync(stale);
      return true;
    } catch (e) { return missing(e); }
  }

  private releaseWriteLock(): void {
    const lock = join(this.directory, WRITE_LOCK);
    try { if (this.token && smallRead(lock) === this.token) unlinkSync(lock); } catch {}
    this.token = undefined;
  }

  /** A separate short lock lets a skipped writer count loss without acquiring the busy receipt lock. */
  private withCounterLock<T>(fn: () => T): T {
    const lock = join(this.directory, "hermes.writeerrors.lock");
    let fd: number;
    try { fd = safeOpen(lock, constants.O_WRONLY | constants.O_EXCL, true); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !this.takeOverStaleLock(lock)) throw e;
      fd = safeOpen(lock, constants.O_WRONLY | constants.O_EXCL, true);
    }
    const token = lockToken();
    try { writeSync(fd, token); } finally { closeSync(fd); }
    try { return fn(); }
    finally { try { if (smallRead(lock) === token) unlinkSync(lock); } catch {} }
  }

  private readCounter(path: string): { count: number; fragment: boolean } {
    if (!info(path)) return { count: 0, fragment: false };
    const value: unknown = JSON.parse(smallRead(path));
    const count = typeof value === "number" ? value : (value as { count?: unknown } | null)?.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("invalid loss counter");
    return { count, fragment: typeof value === "object" && !!(value as { fragment?: unknown } | null)?.fragment };
  }

  private writeCounter(path: string, value: { count: number; fragment: boolean }): void {
    if (!Number.isSafeInteger(value.count) || value.count < 0) throw new Error("loss counter overflow");
    const fd = safeOpen(path, constants.O_RDWR, true);
    try {
      const bytes = Buffer.from(JSON.stringify(value) + "\n");
      if (writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("short loss counter write");
      ftruncateSync(fd, bytes.length);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  private countLoss(): void {
    try {
      privateDirectory(this.directory);
      this.withCounterLock(() => {
        const path = join(this.directory, "hermes.writeerrors");
        const old = this.readCounter(path);
        this.writeCounter(path, { count: old.count + this.pending, fragment: old.fragment });
      });
      this.pending = 0;
      return;
    } catch {}
    // A contended/broken counter must not erase a skipped receipt. Unique counters cannot lose concurrent
    // increments. A reader-compatible pending fragment makes fallback/unacknowledged loss visible immediately.
    try {
      privateDirectory(this.directory);
      this.markCounterUnacknowledged(); // coverage marker precedes fallback persistence, including a crash between them
      const path = `${this.file}.errors-${randomUUID()}`;
      const fd = safeOpen(path, constants.O_WRONLY | constants.O_EXCL, true);
      try { writeSync(fd, JSON.stringify(this.pending) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      this.pending = 0;
    } catch {}
  }

  private markCounterUnacknowledged(): void {
    try {
      const path = join(this.directory, "hermes.writeerrors.pending");
      // Never discard a pre-existing pending count from another compatible writer.
      const existing = this.readCounter(path);
      if (existing.count || existing.fragment) return;
      this.writeCounter(path, { count: 0, fragment: true });
    } catch { /* an unreadable planted counter itself makes the audit incomplete */ }
  }

  private losses(): { count: number; primary: number; paths: string[]; unacknowledged: boolean } {
    const paths: string[] = [];
    let count = 0;
    let primary = 0;
    let unacknowledged = false;
    try {
      this.withCounterLock(() => {
        const current = this.readCounter(join(this.directory, "hermes.writeerrors"));
        primary = current.count;
        count += primary;
        unacknowledged ||= current.fragment;
      });
    } catch { unacknowledged = true; }
    try { const pending = this.readCounter(join(this.directory, "hermes.writeerrors.pending")); unacknowledged ||= !!pending.count || pending.fragment; }
    catch { unacknowledged = true; }
    try {
      const directory = opendirSync(this.directory);
      try {
        for (let scanned = 0; ; scanned++) {
          if (scanned >= 1_024) { unacknowledged = true; break; }
          const entry = directory.readSync();
          if (!entry) break;
          if (!entry.name.startsWith("hermes.jsonl.errors-")) continue;
          const path = join(this.directory, entry.name);
          try {
            const n = JSON.parse(smallRead(path));
            if (!Number.isSafeInteger(n) || n <= 0) throw new Error("invalid loss counter");
            paths.push(path); count += n;
          } catch { unacknowledged = true; }
        }
      } finally { directory.closeSync(); }
    } catch { unacknowledged = true; }
    return { count, primary, paths, unacknowledged };
  }

  private acknowledge(losses: { primary: number; paths: string[] }): void {
    // Subtract only the snapshot: increments made while this receipt was syncing remain pending.
    if (losses.primary) {
      try {
        this.withCounterLock(() => {
          const path = join(this.directory, "hermes.writeerrors");
          const current = this.readCounter(path);
          if (current.count < losses.primary) throw new Error("loss counter changed unexpectedly");
          this.writeCounter(path, { count: current.count - losses.primary, fragment: current.fragment });
        });
      } catch { this.markCounterUnacknowledged(); }
    }
    for (const path of losses.paths) { try { unlinkSync(path); } catch { this.markCounterUnacknowledged(); } }
  }

  private problem(message: string): void {
    if (this.reported) return;
    this.reported = true;
    try { this.warn(redact(message) as string, { file: this.file }); } catch {}
  }
}

/** Plain Carl installations do not write UltraTerm's log; the directory override is only a destination switch. */
export function recordDeliveries(api: { onDelivered?: (method: string, body: Record<string, unknown>, result: unknown, outcome?: TelegramOutcome) => void }, ultraTermWired: boolean, warn: Warn, origin: LogOrigin = {}): boolean {
  if (!ultraTermWired) return false;
  const messages = new MessageLog(messageLogDir(), warn, origin);
  api.onDelivered = (method, body, result, outcome) => messages.record(method, body, result, outcome);
  return true;
}
