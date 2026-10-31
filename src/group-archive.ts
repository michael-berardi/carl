// Group archive: every message in a Telegram group Carl is in is kept locally (CARL_HOME/groups/<chat>/messages.jsonl,
// 0600), whether or not it was addressed to Carl or sent by a listed member. Reading is a tool (group_history), scoped
// so a group conversation sees only its own chat. Nothing is forwarded or sent anywhere to read history.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { TgMessage } from "./channels/telegram-api.ts";

export interface ArchivedMessage {
  id: number;
  chat: number;
  at: string;
  fromId?: number;
  from: string;
  text: string;
  replyTo?: number;
  media?: string[];
  edited?: boolean;
  bot?: boolean;
}

const MAX_BYTES = 20 * 1024 * 1024;

export class GroupArchive {
  readonly dir: string;
  private readonly warn: (msg: string, data?: Record<string, unknown>) => void;
  constructor(home: string, warn: (msg: string, data?: Record<string, unknown>) => void = () => {}) {
    this.dir = join(home, "groups");
    this.warn = warn;
  }

  file(chat: number): string {
    if (!Number.isSafeInteger(chat) || chat >= 0) throw new Error(`group archive: ${chat} is not a group chat id`);
    return join(this.dir, String(chat), "messages.jsonl");
  }

  /** Record a group message. Never throws: a failed write is logged with its cause, the message is still handled. */
  record(m: TgMessage, o: { edited?: boolean; bot?: boolean } = {}): void {
    if (m.chat.type === "private" || m.chat.id >= 0) return;
    const media = (["photo", "document", "voice", "audio"] as const).filter((k) => (m as any)[k]);
    const name = m.from ? [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || String(m.from.id) : "unknown";
    const row: ArchivedMessage = {
      id: m.message_id,
      chat: m.chat.id,
      at: new Date((m.date || Date.now() / 1000) * 1000).toISOString(),
      fromId: m.from?.id,
      from: name,
      text: m.text ?? m.caption ?? "",
      ...(m.reply_to_message ? { replyTo: m.reply_to_message.message_id } : {}),
      ...(media.length ? { media: [...media] } : {}),
      ...(o.edited ? { edited: true } : {}),
      ...(o.bot ? { bot: true } : {}),
    };
    this.append(row);
  }

  append(row: ArchivedMessage): void {
    try {
      const f = this.file(row.chat);
      mkdirSync(join(this.dir, String(row.chat)), { recursive: true, mode: 0o700 });
      if (existsSync(f) && statSync(f).size > MAX_BYTES) renameSync(f, `${f}.1`);
      appendFileSync(f, JSON.stringify(row) + "\n", { mode: 0o600 });
      chmodSync(f, 0o600);
    } catch (e) {
      this.warn("cannot write the group archive", { chat: row.chat, error: (e as Error).message });
    }
  }

  /** Messages of one chat, oldest first; an edit replaces the earlier text of the same message. */
  read(chat: number, o: { afterId?: number; sinceMs?: number; limit?: number } = {}): ArchivedMessage[] {
    const f = this.file(chat);
    const byId = new Map<number, ArchivedMessage>();
    for (const p of [`${f}.1`, f]) {
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as ArchivedMessage;
          const prev = byId.get(r.id);
          byId.set(r.id, prev && r.edited ? { ...prev, text: r.text, edited: true } : prev ?? r);
        } catch { /* a torn last line from a crash */ }
      }
    }
    let rows = [...byId.values()].sort((a, b) => a.id - b.id);
    if (o.afterId !== undefined) rows = rows.filter((r) => r.id > o.afterId!);
    if (o.sinceMs !== undefined) rows = rows.filter((r) => Date.parse(r.at) >= o.sinceMs!);
    return o.limit ? rows.slice(-o.limit) : rows;
  }
}

/**
 * Which chats a conversation may read, from its session folder name (sessions/<key with separators as _>):
 * a group conversation reads only its own group; the operator's DM, the local CLI, the API and schedules read any group.
 * Anyone else's DM reads none.
 */
export function readableScope(sessionDir: string | undefined, operators: number[]): { only?: number; none?: boolean } {
  const name = sessionDir ? basename(sessionDir) : "";
  const g = name.match(/^telegram_group_(-\d+)/);
  if (g) return { only: Number(g[1]) };
  const d = name.match(/^telegram_dm_(\d+)/);
  if (d) return operators.includes(Number(d[1])) ? {} : { none: true };
  if (/^(slack|discord)_/.test(name)) return { none: true };
  return {};
}

export function formatRows(rows: ArchivedMessage[]): string {
  return rows.map((r) => {
    const when = r.at.slice(0, 16).replace("T", " ");
    const extra = [r.replyTo ? `reply to #${r.replyTo}` : "", r.media?.length ? r.media.join("+") : "", r.edited ? "edited" : ""].filter(Boolean).join(", ");
    return `#${r.id} ${when}Z ${r.from}${r.bot ? " (bot)" : ""}${extra ? ` [${extra}]` : ""}: ${r.text.length > 6000 ? r.text.slice(0, 6000) + "…" : r.text}`;
  }).join("\n\n");
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

export function groupHistoryTool(archive: GroupArchive, operators: number[], afterIdFor?: (chat: number) => number | undefined): ToolDefinition {
  return defineTool({
    name: "group_history",
    label: "Group history",
    description:
      "Read messages from a Telegram group you are in, from your own local archive (every message, addressed to you or not). In a group conversation you can read only that group (chat may be omitted). Use it to find what people said earlier, e.g. feedback that has not been acted on yet (unqueued_only).",
    parameters: Type.Object({
      chat: Type.Optional(Type.Number({ description: "group chat id; omit in a group conversation" })),
      hours: Type.Optional(Type.Number({ description: "only the last N hours (default 72)" })),
      unqueued_only: Type.Optional(Type.Boolean({ description: "only messages after the last one already turned into queued work (work module)" })),
      from: Type.Optional(Type.String({ description: "only messages whose sender name contains this" })),
      limit: Type.Optional(Type.Number({ description: "max messages, newest kept (default 80)" })),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const scope = readableScope((ctx as any)?.sessionManager?.getSessionDir?.(), operators);
      if (scope.none) throw new Error("group history is not available in this conversation");
      const chat = p.chat ?? scope.only;
      if (chat === undefined) throw new Error("name the group chat id");
      if (scope.only !== undefined && chat !== scope.only) throw new Error("in a group conversation you can read only this group's history");
      const afterId = p.unqueued_only ? afterIdFor?.(chat) : undefined;
      let rows = archive.read(chat, { afterId, sinceMs: Date.now() - (p.hours ?? 72) * 3_600_000 });
      if (p.from) rows = rows.filter((r) => r.from.toLowerCase().includes(p.from!.toLowerCase()));
      rows = rows.slice(-(p.limit ?? 80));
      if (!rows.length) return ok(`No archived messages in chat ${chat} for that window${afterId !== undefined ? ` after #${afterId}` : ""}.`);
      return ok(formatRows(rows));
    },
  });
}
