// Work module: people in a team group ask Carl to turn their requests into queued work. Off unless `work` is set in
// carl.json and a group has `work: {project}`. The agent calls work_queue; Carl runs the operator's fixed command
// (argv from carl.json, no shell) with the request as JSON on stdin. The agent cannot change what runs or where the
// work reports back: the chat comes from the conversation, the project from the group's config.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CarlConfig } from "./config.ts";
import { readableScope } from "./group-archive.ts";

export interface WorkRequest {
  chat: number;
  project: string;
  title: string;
  request: string;
  messageIds: number[];
  requestedBy: string;
}

export class WorkLedger {
  private readonly home: string;
  constructor(home: string) { this.home = home; }
  private file(chat: number) {
    return join(this.home, "groups", String(chat), "work.json");
  }
  /** Highest group message id already turned into queued work, if any. */
  lastQueued(chat: number): number | undefined {
    try { return JSON.parse(readFileSync(this.file(chat), "utf8")).lastQueuedId; } catch { return undefined; }
  }
  markQueued(chat: number, ids: number[], job: string): void {
    const f = this.file(chat);
    mkdirSync(join(this.home, "groups", String(chat)), { recursive: true, mode: 0o700 });
    let cur: { lastQueuedId?: number; jobs?: { job: string; ids: number[]; at: string }[] } = {};
    try { cur = JSON.parse(readFileSync(f, "utf8")); } catch { /* first */ }
    const last = Math.max(cur.lastQueuedId ?? 0, ...ids);
    const jobs = [...(cur.jobs ?? []), { job, ids, at: new Date().toISOString() }].slice(-200);
    writeFileSync(`${f}.tmp`, JSON.stringify({ lastQueuedId: last, jobs }, null, 2), { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }
}

export function runWorkCommand(argv: string[], req: WorkRequest | Record<string, unknown>, timeoutMs = 120_000): Promise<string> {
  const [cmd, ...args] = argv;
  if (!cmd || !existsSync(cmd)) return Promise.reject(new Error(`work.command ${cmd ?? "(empty)"} does not exist`));
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`queueing failed (${cmd}): ${(stderr || stdout || err.message).trim().slice(0, 800)}`));
      else resolve(stdout.trim().slice(0, 2_000));
    });
    child.stdin?.end(JSON.stringify(req));
  });
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

export function workTools(cfg: CarlConfig, ledger = new WorkLedger(cfg.home)): ToolDefinition[] {
  if (!cfg.work) return [];
  const command = cfg.work.command;
  const groups = cfg.telegram.groups.filter((g) => g.work);
  if (!groups.length) return [];
  return [
    defineTool({
      name: "work_queue",
      label: "Queue work",
      description:
        "Turn requests from this group into one queued work job that a worker carries out and reports back to this group. Use only when someone asks you to queue or start the work. Put the requests in `request` faithfully (who said what, with message ids); do not invent requirements. Returns the job id; then tell the group in two or three short lines what will be done.",
      parameters: Type.Object({
        title: Type.String({ description: "short job title, e.g. 'Example: feedback'" }),
        request: Type.String({ description: "the requests to act on, faithful to what was said, grouped by site or topic" }),
        message_ids: Type.Array(Type.Number(), { description: "the group message ids these requests come from" }),
        requested_by: Type.String({ description: "who asked for the work to be queued" }),
        chat: Type.Optional(Type.Number({ description: "only from the operator's direct chat: the group to work for" })),
      }),
      async execute(_id, p, _signal, _update, ctx) {
        const scope = readableScope((ctx as any)?.sessionManager?.getSessionDir?.(), cfg.telegram.allowFrom);
        if (scope.none) throw new Error("work can be queued only from a team group or by the operator");
        const chat = scope.only ?? p.chat;
        if (chat === undefined) throw new Error("name the group chat id");
        if (scope.only !== undefined && p.chat !== undefined && p.chat !== scope.only) throw new Error("from a group you can queue work only for that group");
        const group = groups.find((g) => g.chat === chat);
        if (!group?.work) throw new Error(`group ${chat} has no work set up (telegram.groups[].work)`);
        if (!p.title.trim() || !p.request.trim()) throw new Error("title and request are required");
        const ids = p.message_ids.filter((n) => Number.isSafeInteger(n));
        const req: WorkRequest = { chat, project: group.work.project, title: p.title.trim(), request: p.request.trim(), messageIds: ids, requestedBy: p.requested_by.trim() || "unknown" };
        const out = await runWorkCommand(command, req);
        const job = out.match(/\bJ-\d+\b/)?.[0] ?? "";
        if (ids.length) ledger.markQueued(chat, ids, job || out.slice(0, 80));
        return ok(job ? `Queued ${job}. ${out}` : out);
      },
    }),
  ];
}
