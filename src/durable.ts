// Durable delivery and resume: the two small pieces of state that let a restarted gateway finish what it started
// without repeating a side effect.
//   - state/deliveries.json: which replies already went out. A delivery id is recorded before the send and marked
//     sent after it, so a crash between the send and the persist cannot send the same reply twice - as long as the
//     ledger still holds the record.
//   - the Pi transcript: what a turn had already done. A resumed turn takes the recorded tool results from the
//     transcript and never runs a recorded tool again.
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Log } from "./log.ts";

/**
 * The id of one reply: the conversation, the operator's message and the part of the turn it belongs to.
 * It is stable across restarts, so the same reply is never sent twice. The turn is deliberately not part of it:
 * a compaction shrinks the count of user messages, and the same message must keep the same id anyway.
 */
export function deliveryId(key: string, messageId: number | string, part = "answer"): string {
  return `${key}#${messageId}#${part}`;
}

/** A short, stable id for something that is not a reply (a card, a schedule notice). */
export function stableId(...parts: (string | number)[]): string {
  return parts.join("#");
}

/** What the ledger keeps about a delivery: how long it was and a hash of it, never the text itself. */
export interface DeliveryPreview {
  /** The length of the delivered text, in characters. */
  len: number;
  /** A short hash of the delivered text: enough to recognise it, not enough to read it. */
  hash: string;
}

/** The record of a delivery, without its text: only its size and a hash. */
export function previewOf(text: string): DeliveryPreview {
  return { len: text.length, hash: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}

export interface DeliveryRecord {
  /** "sending": the send was started and nobody confirmed it. "sent": the channel took it. */
  phase: "sending" | "sent";
  at: string;
  chatId?: number;
  /** The channel's message ids, when the send was confirmed. */
  messageIds?: number[];
  /** The size of what went out and a hash of it: never the text. */
  preview?: DeliveryPreview;
  /** Set when the thing that was sent is settled (a card the operator answered): a new one may be sent. */
  resolved?: boolean;
}

/** What a caller may do with a delivery id. */
export type DeliveryState =
  /** The reply was never sent: send it. */
  | "new"
  /** The reply was already delivered: do not send it again. */
  | "sent"
  /** A send was started but never confirmed: it may or may not have gone out, so do not send it again. */
  | "unconfirmed";

const KEEP_MS = 7 * 24 * 3_600_000;
const MAX_RECORDS = 500;

/** A durable record of what was already delivered, so a restart never sends a reply twice. */
export class DeliveryLedger {
  private readonly file: string;
  private readonly log?: Log;
  private records?: Record<string, DeliveryRecord>;
  /** True when the ledger on disk could not be read: nothing is sent again until it is repaired. */
  private corrupt = false;

  constructor(home: string, log?: Log) {
    this.file = join(home, "state", "deliveries.json");
    this.log = log;
  }

  private load(): Record<string, DeliveryRecord> {
    if (!this.records) {
      if (!existsSync(this.file)) {
        this.records = {};
        return this.records;
      }
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the ledger is not a map of deliveries");
        this.records = raw as Record<string, DeliveryRecord>;
      } catch (e) {
        // A corrupt ledger fails closed: it does not say what went out, so nothing is sent again.
        this.corrupt = true;
        this.records = {};
        this.preserveCorrupt(e as Error);
      }
    }
    return this.records!;
  }

  /** Keep the unreadable ledger as it is, next to a copy, so it can be looked at. */
  private preserveCorrupt(err: Error): void {
    const copy = `${this.file}.corrupt-${Date.now()}`;
    try {
      copyFileSync(this.file, copy);
      chmodSync(copy, 0o600);
    } catch {}
    this.log?.error("the delivery ledger is corrupt: no reply is sent again until it is repaired", { file: this.file, copy, error: err.message });
  }

  private save(): void {
    if (this.corrupt) return; // a corrupt ledger is never overwritten: it is kept for inspection
    const all = this.load();
    const now = Date.now();
    const age = (r: DeliveryRecord): number => {
      const t = Date.parse(r.at ?? "");
      return Number.isNaN(t) ? 0 : now - t;
    };
    const kept = Object.entries(all)
      .filter(([, r]) => age(r) < KEEP_MS)
      .sort((a, b) => age(a[1]) - age(b[1]));   // newest first
    // The newest records are the ones that matter: an old delivery is the one that may be forgotten.
    const trimmed = kept.slice(0, MAX_RECORDS);
    this.records = Object.fromEntries(trimmed);
    // A unique name per write, so two writers never share a temporary file, and the rename is atomic.
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(this.records));
        fsyncSync(fd); // the bytes are on the disk before the file is put in place
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
      this.syncDir(dirname(this.file)); // the rename itself is durable
    } catch (e) {
      this.log?.error("cannot write the delivery ledger", { error: (e as Error).message });
      try { unlinkSync(tmp); } catch {}
    }
  }

  /** Make the rename durable: the directory entry itself has to reach the disk. */
  private syncDir(dir: string): void {
    try {
      const fd = openSync(dir, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch {
      // Not every file system allows it; the file itself is already on the disk.
    }
  }

  /** The record of a delivery id, if there is one. */
  get(id: string): DeliveryRecord | undefined {
    return this.load()[id];
  }

  /**
   * Claim a delivery id before sending. The record is written first, so a crash after the send still leaves a trace
   * that stops the same reply from going out twice.
   */
  begin(id: string, meta: { chatId?: number; preview?: string } = {}): DeliveryState {
    const all = this.load();
    if (this.corrupt) {
      // Fail closed: the ledger does not say what went out, so nothing goes out again.
      this.log?.warn("the delivery ledger is corrupt; not sending this again", { id });
      return "unconfirmed";
    }
    const existing = all[id];
    if (existing && !existing.resolved) return existing.phase === "sent" ? "sent" : "unconfirmed";
    all[id] = {
      phase: "sending",
      at: new Date().toISOString(),
      chatId: meta.chatId,
      preview: meta.preview === undefined ? undefined : previewOf(meta.preview),
    };
    this.save();
    return "new";
  }

  /** Mark a delivery as confirmed by the channel. */
  sent(id: string, messageIds?: number[]): void {
    if (this.corrupt) return;
    const all = this.load();
    const existing = all[id];
    all[id] = { phase: "sent", at: new Date().toISOString(), chatId: existing?.chatId, messageIds, preview: existing?.preview };
    this.save();
  }

  /** Forget a delivery that did not go out, so a later attempt can send it. */
  drop(id: string): void {
    if (this.corrupt) return;
    const all = this.load();
    if (!(id in all)) return;
    delete all[id];
    this.save();
  }

  /** Mark a delivery as settled: the operator answered it, so a new one may be sent. */
  resolve(id: string): void {
    if (this.corrupt) return;
    const all = this.load();
    const existing = all[id];
    if (!existing) return;
    all[id] = { ...existing, resolved: true, at: new Date().toISOString() };
    this.save();
  }
}

/** A tool call the interrupted turn issued. */
export interface ToolCallState {
  id: string;
  name: string;
  /** True when the transcript holds a result for this call. */
  answered: boolean;
}

/** What the interrupted turn had achieved. */
export type TurnState =
  /** The turn never ran: nothing was issued, so it can be run again from the start. */
  | "nothing"
  /** The turn is waiting for the model: its tool calls are recorded and the model owes an answer. */
  | "waiting"
  /** The turn already produced its answer. */
  | "answered";

export interface TurnInspection {
  /** The turn number: the count of user messages up to and including the interrupted one. */
  turn: number;
  /** Every tool call the turn issued. */
  calls: ToolCallState[];
  /** The calls without a result: their effect is unknown. */
  pending: ToolCallState[];
  /** The answer the turn already produced, when it produced one. */
  finalText?: string;
  state: TurnState;
}

/** The text of a message, whatever shape its content has. */
export function contentText(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

/** The plain text of an assistant message. */
export function assistantText(m: any): string {
  return (m.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")
    .trim();
}

/**
 * Look at a transcript and say what the turn around the operator's message achieved. The needle is the operator's
 * text, trimmed and matched exactly: the same words, not a prefix of them. The turn ends at the next user message:
 * what a later turn did is not this turn's work.
 */
export function inspectTurn(messages: any[], text: string): TurnInspection | undefined {
  const needle = text.trim();
  if (!needle) return undefined;
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && contentText(messages[i]).trim() === needle) {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return undefined;
  let turn = 0;
  for (let i = 0; i <= userIndex; i++) if (messages[i]?.role === "user") turn++;
  const calls: ToolCallState[] = [];
  const byId = new Map<string, ToolCallState>();
  const after: any[] = [];
  for (let i = userIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "user") break;   // the next turn starts here
    after.push(m);
    if (m?.role === "assistant") {
      for (const c of m.content ?? []) {
        if (c?.type !== "toolCall" || !c.id) continue;
        const call: ToolCallState = { id: c.id, name: c.name ?? "tool", answered: false };
        calls.push(call);
        byId.set(call.id, call);
      }
    } else if (m?.role === "toolResult") {
      const call = byId.get(m.toolCallId);
      if (call) call.answered = true;
    }
  }
  const pending = calls.filter((c) => !c.answered);
  const last = after[after.length - 1];
  if (!after.length) return { turn, calls, pending, state: "nothing" };
  if (last?.role === "assistant" && !pending.length) {
    return { turn, calls, pending, finalText: assistantText(last), state: "answered" };
  }
  return { turn, calls, pending, state: "waiting" };
}

/** What a tool result says when the turn it belongs to was cut short by a restart. */
export const INTERRUPTED_TOOL_RESULT =
  "interrupted by a restart; it may or may not have taken effect; do not repeat it without checking";

/** The structured mark on that result: Carl reads this, not the sentence above. */
export const INTERRUPTED_MARK = { interruptedByRestart: true } as const;

/** An honest result for a tool call that never came back: the model is told the truth, not a fake failure. */
export function interruptedToolResult(call: { id: string; name: string }): any {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
    // A structured field, not a phrase in the text: the model's wording may change, this mark may not.
    details: { ...INTERRUPTED_MARK },
    isError: true,
    timestamp: Date.now(),
  };
}

/** True when a tool result is the honest result of a call a restart cut short. */
export function isInterruptedResult(m: any): boolean {
  return !!m && m.role === "toolResult" && (m.details?.interruptedByRestart === true);
}
