// UltraTerm's UltraBot message log: every message Carl's Telegram channel delivers is appended to
// ~/.ultraterm/logs/ultrabot-messages/hermes.jsonl, the gateway file `utp ultrabot audit` reads. UltraTerm's app
// writes its own sends to app.jsonl, `utp` writes utp.jsonl, and this writer owns hermes.jsonl, so no two processes
// share a file. On this Mac UltraTerm runs UltraBot in custom mode: Carl *is* the gateway, so without these rows a
// Carl-served chat is invisible to the audit.
//
// A row records what Telegram accepted, with the text the chat shows (HTML turned back into plain text). A send that
// failed is not a delivered message and stays out of the row set; the channel already reports it in carl.log and its
// outbox. Writing is best effort and never blocks or fails a send.
import { appendFileSync, renameSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { htmlToPlain } from "./channels/format.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 5;
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
 * touch the operator's real UltraTerm logs on this machine.
 */
export function messageLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CARL_MESSAGE_LOG_DIR?.trim();
  return override ? override : join(homedir(), ".ultraterm", "logs", "ultrabot-messages");
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
  const single = positiveId(body.message_id) ?? positiveId(sent?.message_id);
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
      this.rotate();
      appendFileSync(this.file, JSON.stringify(row) + "\n", { mode: 0o600 });
    } catch (e) {
      this.problem(`message log write failed: ${(e as Error).message}`);
    }
  }

  /** hermes.jsonl becomes hermes.jsonl.1, .1 becomes .2 and so on; what was .5 is dropped, matching `utp`. */
  private rotate(): void {
    const size = statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
    if (size < MAX_BYTES) return;
    try {
      unlinkSync(`${this.file}.${KEEP}`);
    } catch {}
    for (let n = KEEP - 1; n >= 1; n--) {
      try {
        renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
      } catch {}
    }
    renameSync(this.file, `${this.file}.1`);
  }

  private problem(message: string): void {
    if (this.reported) return; // one line per process: a shut-down log must not flood carl.log on every send
    this.reported = true;
    this.warn(message, { file: this.file });
  }
}

/**
 * Record this process's Telegram deliveries when the installation is wired to UltraTerm (the log is UltraTerm's) or a
 * test set CARL_MESSAGE_LOG_DIR. Returns whether the log is on.
 */
export function recordDeliveries(api: { onDelivered?: (method: string, body: Record<string, unknown>, result: unknown) => void }, ultraTermWired: boolean, warn: Warn): boolean {
  if (!ultraTermWired && !process.env.CARL_MESSAGE_LOG_DIR) return false;
  const messages = new MessageLog(messageLogDir(), warn);
  api.onDelivered = (method, body, result) => messages.record(method, body, result);
  return true;
}
