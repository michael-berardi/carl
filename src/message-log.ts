// UltraTerm's UltraBot message log: every message Carl's Telegram channel delivers is appended to
// ~/.ultraterm/logs/ultrabot-messages/hermes.jsonl, the gateway file `utp ultrabot audit` reads. UltraTerm's app
// writes its own sends to app.jsonl, `utp` writes utp.jsonl, and this writer owns hermes.jsonl, so no two processes
// share a file. On this Mac UltraTerm runs UltraBot in custom mode: Carl *is* the gateway, so without these rows a
// Carl-served chat is invisible to the audit.
//
// A row records what Telegram accepted, with the text the chat shows (HTML turned back into plain text). A send that
// failed is not a delivered message and stays out of the row set; the channel already reports it in carl.log and its
// outbox. Writing is best effort and never blocks or fails a send.
//
// The directory and the 10 MiB rotation with five kept files match the installed `utp` writer (MESSAGE_LOG_DIR,
// MESSAGE_LOG_MAX_BYTES, MESSAGE_LOG_KEEP). Two Carl processes can share this file: the gateway and `carl send`, so
// every write (rotation and append) happens under one short exclusive lock; a lock that is held or left behind by a
// killed process is taken over after a few seconds, and a write that cannot take it is skipped rather than faked.
import { appendFileSync, chmodSync, closeSync, openSync, renameSync, statSync, truncateSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToPlain } from "./channels/format.ts";

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
  if (env.NODE_TEST_CONTEXT) return join(tmpdir(), `carl-message-log-${process.pid}`);
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
  return labels.length ? labels : null;
}

/** The row for one delivered call, or nothing when the call is not a message or has no usable identity. */
export function deliveryRow(method: string, body: Record<string, unknown>, result: unknown, at: Date = new Date()): Record<string, unknown> | undefined {
  if (!MESSAGE_METHODS.has(method)) return undefined;
  const chatId = numericChat(body.chat_id);
  if (!chatId) return undefined;
  const sent = result && typeof result === "object" ? (result as { message_id?: unknown }) : undefined;
  // The result carries the id of the message Telegram created; the body only carries the id of a message being
  // changed (an edit or a deletion) or, for a copy or a forward, the id of the source message.
  const single = positiveId(sent?.message_id) ?? positiveId(body.message_id);
  const many = Array.isArray(body.message_ids) ? body.message_ids.map(positiveId) : [];
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

/** Appends delivered rows to hermes.jsonl in the UltraTerm message log. One instance per process. */
export class MessageLog {
  private readonly directory: string;
  private readonly warn: Warn;
  private reported = false;

  constructor(directory = messageLogDir(), warn: Warn = () => {}) {
    this.directory = directory;
    this.warn = warn;
  }

  get file(): string {
    return join(this.directory, "hermes.jsonl");
  }

  /** Record one delivered Bot API call. Never throws: a lost log line must not lose the reply. */
  record(method: string, body: Record<string, unknown>, result: unknown): void {
    let row: Record<string, unknown> | undefined;
    try {
      row = deliveryRow(method, body, result);
    } catch (e) {
      return this.problem(`message log row could not be built: ${(e as Error).message}`);
    }
    if (!row) return;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    } catch (e) {
      return this.problem(`message log write failed: ${(e as Error).message}`);
    }
    this.tightenDirectory();
    // One Carl process writes this file at a time: the gateway and `carl send` share it.
    if (!this.takeWriteLock()) return;
    try {
      this.rotate();
      const before = statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
      try {
        appendFileSync(this.file, JSON.stringify(row) + "\n", { mode: 0o600 });
      } catch (e) {
        // A half-written line would be a broken row, so the file goes back to what it was before this append.
        // No other Carl process can be writing here, so this cannot remove someone else's row.
        try {
          truncateSync(this.file, before);
        } catch {}
        throw e;
      }
      this.tightenFile();
    } catch (e) {
      this.problem(`message log write failed: ${(e as Error).message}`);
    } finally {
      this.releaseWriteLock();
    }
  }

  /** hermes.jsonl becomes hermes.jsonl.1, .1 becomes .2 and so on; what was .5 is dropped, matching `utp`. */
  private rotate(): void {
    // The size is read here, under the lock: a file that was already rotated by the other process is left alone.
    const size = statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
    if (size < MAX_BYTES) return;
    try {
      try {
        unlinkSync(`${this.file}.${KEEP}`);
      } catch {}
      for (let n = KEEP - 1; n >= 1; n--) {
        try {
          this.makeOwnerOnly(`${this.file}.${n}`);
          renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
        } catch {}
      }
      this.makeOwnerOnly(this.file);
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // A failed rotation leaves the rows where they are; the next write tries again.
    }
  }

  /** Owner-only before a rename, so a loose file is never readable under a rotated name. */
  private makeOwnerOnly(path: string): void {
    try {
      chmodSync(path, 0o600);
    } catch {}
  }

  /** The log file is owner-only, also when it already existed with looser permissions. */
  private tightenFile(): void {
    try {
      const info = statSync(this.file);
      if (info.mode & 0o077) chmodSync(this.file, 0o600);
    } catch {}
  }

  /** The log folder is owner-only, also when it already existed with looser permissions. */
  private tightenDirectory(): void {
    try {
      const info = statSync(this.directory);
      if (info.mode & 0o077) chmodSync(this.directory, 0o700);
    } catch {}
  }

  /**
   * The exclusive lock for writing this file. A lock left behind by a killed process is taken over after
   * STALE_LOCK_MS; the takeover renames the stale lock first, so only one process can claim it.
   */
  private takeWriteLock(): boolean {
    const lock = join(this.directory, WRITE_LOCK);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        closeSync(openSync(lock, "wx", 0o600));
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
        try {
          if (Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return false;
          // The rename is atomic: whichever process renames the stale lock owns the takeover.
          const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
          renameSync(lock, stale);
          try {
            unlinkSync(stale);
          } catch {}
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  private releaseWriteLock(): void {
    try {
      unlinkSync(join(this.directory, WRITE_LOCK));
    } catch {}
  }

  private problem(message: string): void {
    if (this.reported) return; // one line per process: a shut-down log must not flood carl.log on every send
    this.reported = true;
    try {
      this.warn(message, { file: this.file });
    } catch {
      // Even the warning must not escape into the send path.
    }
  }
}

/**
 * Record this process's Telegram deliveries when the installation is wired to UltraTerm (the log is UltraTerm's).
 * CARL_MESSAGE_LOG_DIR only says where the rows go, never whether they are written: a plain Carl install never
 * writes into UltraTerm's log directory. Returns whether the log is on.
 */
export function recordDeliveries(api: { onDelivered?: (method: string, body: Record<string, unknown>, result: unknown) => void }, ultraTermWired: boolean, warn: Warn): boolean {
  if (!ultraTermWired) return false;
  const messages = new MessageLog(messageLogDir(), warn);
  api.onDelivered = (method, body, result) => messages.record(method, body, result);
  return true;
}
