// Durable delivery and resume: the two small pieces of state that let a restarted gateway finish what it started
// without repeating a side effect.
//   - state/deliveries.json: which replies already went out. A delivery id is recorded before the send and marked
//     sent after it, so a crash between the send and the persist cannot send the same reply twice.
//   - the Pi transcript: what a turn had already done. A resumed turn takes the recorded tool results from the
//     transcript and never runs a recorded tool again.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The id of one reply: the conversation, the operator's message, the turn it belongs to and the part of the turn.
 * It is stable across restarts, so the same reply is never sent twice.
 */
export function deliveryId(key: string, messageId: number | string, turn: number, part = "answer"): string {
  return `${key}#${messageId}#${turn}#${part}`;
}

/** A short, stable id for something that is not a reply (a card, a schedule notice). */
export function stableId(...parts: (string | number)[]): string {
  return parts.join("#");
}

export interface DeliveryRecord {
  /** "sending": the send was started and nobody confirmed it. "sent": the channel took it. */
  phase: "sending" | "sent";
  at: string;
  chatId?: number;
  /** The channel's message ids, when the send was confirmed. */
  messageIds?: number[];
  /** A short excerpt, so the ledger says what it is about. */
  preview?: string;
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
  private records?: Record<string, DeliveryRecord>;

  constructor(home: string) {
    this.file = join(home, "state", "deliveries.json");
  }

  private load(): Record<string, DeliveryRecord> {
    if (!this.records) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8"));
        this.records = raw && typeof raw === "object" ? (raw as Record<string, DeliveryRecord>) : {};
      } catch {
        this.records = {};
      }
    }
    return this.records!;
  }

  private save(): void {
    const all = this.load();
    const now = Date.now();
    const age = (r: DeliveryRecord): number => {
      const t = Date.parse(r.at ?? "");
      return Number.isNaN(t) ? 0 : now - t;
    };
    const kept = Object.entries(all)
      .filter(([, r]) => age(r) < KEEP_MS)
      .sort((a, b) => age(a[1]) - age(b[1]));    const trimmed = kept.slice(Math.max(0, kept.length - MAX_RECORDS));
    this.records = Object.fromEntries(trimmed);
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.records), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // A ledger that cannot be written must not stop a reply: the worst case is a duplicate, not a lost answer.
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
    const existing = all[id];
    if (existing && !existing.resolved) return existing.phase === "sent" ? "sent" : "unconfirmed";
    all[id] = { phase: "sending", at: new Date().toISOString(), chatId: meta.chatId, preview: meta.preview?.slice(0, 160) };
    this.save();
    return "new";
  }

  /** Mark a delivery as confirmed by the channel. */
  sent(id: string, messageIds?: number[]): void {
    const all = this.load();
    const existing = all[id];
    all[id] = { phase: "sent", at: new Date().toISOString(), chatId: existing?.chatId, messageIds, preview: existing?.preview };
    this.save();
  }

  /** Forget a delivery that did not go out, so a later attempt can send it. */
  drop(id: string): void {
    const all = this.load();
    if (!(id in all)) return;
    delete all[id];
    this.save();
  }

  /** Mark a delivery as settled: the operator answered it, so a new one may be sent. */
  resolve(id: string): void {
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
 * Look at a transcript and say what the turn around the operator's message achieved. The needle is the start of the
 * operator's text, the same way the rest of Carl recognises a message in a transcript.
 */
export function inspectTurn(messages: any[], text: string): TurnInspection | undefined {
  const needle = text.slice(0, 200);
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && contentText(messages[i]).includes(needle)) {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return undefined;
  let turn = 0;
  for (let i = 0; i <= userIndex; i++) if (messages[i]?.role === "user") turn++;
  const calls: ToolCallState[] = [];
  const byId = new Map<string, ToolCallState>();
  for (let i = userIndex + 1; i < messages.length; i++) {
    const m = messages[i];
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
  const last = messages[messages.length - 1];
  const after = messages.slice(userIndex + 1);
  if (!after.length) return { turn, calls, pending, state: "nothing" };
  if (last?.role === "assistant" && !pending.length) {
    return { turn, calls, pending, finalText: assistantText(last), state: "answered" };
  }
  return { turn, calls, pending, state: "waiting" };
}

/** What a tool result says when the turn it belongs to was cut short by a restart. */
export const INTERRUPTED_TOOL_RESULT =
  "interrupted by a restart; it may or may not have taken effect; do not repeat it without checking";

/** An honest result for a tool call that never came back: the model is told the truth, not a fake failure. */
export function interruptedToolResult(call: { id: string; name: string }): any {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
    isError: true,
    timestamp: Date.now(),
  };
}
