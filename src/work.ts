// Work module: people in a team group ask Carl to turn their requests into queued work. Off unless `work` is set in
// carl.json and a group has `work: {project}`. The agent calls work_queue; Carl runs the operator's fixed command
// (argv from carl.json, no shell) with the request as JSON on stdin. The agent cannot change what runs or where the
// work reports back: the chat comes from the conversation, the project from the group's config.
// With `work.stopCommand` the agent also gets work_stop, which halts the group's queued or running work through the operator's
// second fixed command; without it a request to stop is answered honestly (there is no tool), never by queueing more work.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /** Absolute paths of files Carl saved for these messages (attachments). */
  files: string[];
}

/** Files Carl saved for the given messages: `<home>/media/<chat>-<id>-*`, regular files only, sorted by name. */
export function filesForMessages(home: string, chat: number, ids: number[]): string[] {
  const dir = join(home, "media");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const prefixes = ids.map((id) => `${chat}-${id}-`);
  return names
    .filter((n) => prefixes.some((p) => n.startsWith(p)))
    .sort()
    .map((n) => join(dir, n))
    .filter((f) => { try { return lstatSync(f).isFile(); } catch { return false; } });
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

/**
 * Runs the operator's stop command with the request as JSON on stdin. Its answer is returned whatever the exit status, because
 * "not halted, and why" is an answer the group must hear; only a command that could not run at all is an error.
 */
export function runStopCommand(argv: string[], req: Record<string, unknown>, timeoutMs = 300_000): Promise<{ halted: boolean; text: string }> {
  const [cmd, ...args] = argv;
  if (!cmd || !existsSync(cmd)) return Promise.reject(new Error(`work.stopCommand ${cmd ?? "(empty)"} does not exist`));
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const text = [stdout, stderr].map((s) => String(s).trim()).filter(Boolean).join("\n").slice(0, 2_000);
      if (!err) return resolve({ halted: true, text: text || "stopped (the stop command printed nothing)" });
      if ((err as any).killed) return reject(new Error(`the stop command did not answer within ${Math.round(timeoutMs / 1000)} s, so whether the work stopped is unknown (${cmd})`));
      if (typeof (err as any).code !== "number") return reject(new Error(`the stop command could not run (${cmd}): ${err.message.slice(0, 400)}`));
      resolve({ halted: false, text: text || `the stop command exited ${(err as any).code} without saying why (${cmd})` });
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
  const stop = cfg.work.stopCommand;
  /** The group a work tool acts for: the conversation's own group, or the one the operator names from their direct chat. */
  const groupFor = (ctx: unknown, asked: number | undefined, verb: string) => {
    const scope = readableScope((ctx as any)?.sessionManager?.getSessionDir?.(), cfg.telegram.allowFrom);
    if (scope.none) throw new Error(`work can be ${verb} only from a team group or by the operator`);
    const chat = scope.only ?? asked;
    if (chat === undefined) throw new Error("name the group chat id");
    if (scope.only !== undefined && asked !== undefined && asked !== scope.only) throw new Error(`from a group you can ${verb === "queued" ? "queue" : "stop"} work only for that group`);
    const group = groups.find((g) => g.chat === chat);
    if (!group?.work) throw new Error(`group ${chat} has no work set up (telegram.groups[].work)`);
    return { chat, project: group.work.project };
  };
  const stopTool = !stop ? [] : [
    defineTool({
      name: "work_stop",
      label: "Stop work",
      description:
        "Stop work that was queued for this group, at once: a job that is waiting or one a worker is carrying out now. Use it whenever someone here asks to stop, halt, cancel or pause that work. Never use work_queue for this: a job cannot stop another job. Name the `job` when they named one or when the group has more than one open job; set `all` only when they asked to stop everything. The answer says, per job, whether it is halted or exactly why it is not. Tell the group that answer plainly and at once, and never say work has stopped unless the answer says halted.",
      parameters: Type.Object({
        reason: Type.String({ description: "why, in the asker's words" }),
        requested_by: Type.String({ description: "who asked for the work to stop" }),
        job: Type.Optional(Type.String({ description: "the job id to stop, e.g. J-1234; omit to stop the group's one open job" })),
        all: Type.Optional(Type.Boolean({ description: "stop every open job of this group" })),
        chat: Type.Optional(Type.Number({ description: "only from the operator's direct chat: the group whose work to stop" })),
      }),
      async execute(_id, p, _signal, _update, ctx) {
        const { chat, project } = groupFor(ctx, p.chat, "stopped");
        const job = p.job?.trim();
        if (job !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(job)) throw new Error("job must be a job id such as J-1234");
        const out = await runStopCommand(stop, { chat, project, ...(job ? { job } : {}), all: p.all === true, reason: p.reason.trim().slice(0, 500), requestedBy: p.requested_by.trim() || "unknown" });
        return ok(out.halted ? out.text : `NOT fully stopped. Tell the group exactly this:\n${out.text}`);
      },
    }),
  ];
  return [
    ...stopTool,
    defineTool({
      name: "work_queue",
      label: "Queue work",
      description:
        "Turn requests from this group into one queued work job that a worker carries out and reports back to this group. Use only when someone asks you to queue or start the work. A request to stop, cancel or halt work is never queued as a job. Files attached to the messages named in `message_ids` are passed along automatically, so include the id of every message that carried a file. Put the requests in `request` faithfully (who said what, with message ids); do not invent requirements. Returns the job id; then tell the group in two or three short lines what will be done.",
      parameters: Type.Object({
        title: Type.String({ description: "short job title, e.g. 'Example: feedback'" }),
        request: Type.String({ description: "the requests to act on, faithful to what was said, grouped by site or topic" }),
        message_ids: Type.Array(Type.Number(), { description: "the group message ids these requests come from" }),
        requested_by: Type.String({ description: "who asked for the work to be queued" }),
        chat: Type.Optional(Type.Number({ description: "only from the operator's direct chat: the group to work for" })),
      }),
      async execute(_id, p, _signal, _update, ctx) {
        const { chat, project } = groupFor(ctx, p.chat, "queued");
        if (!p.title.trim() || !p.request.trim()) throw new Error("title and request are required");
        const ids = p.message_ids.filter((n) => Number.isSafeInteger(n));
        const req: WorkRequest = { chat, project, title: p.title.trim(), request: p.request.trim(), messageIds: ids, requestedBy: p.requested_by.trim() || "unknown", files: filesForMessages(cfg.home, chat, ids) };
        const out = await runWorkCommand(command, req);
        const job = out.match(/\bJ-\d+\b/)?.[0] ?? "";
        if (ids.length) ledger.markQueued(chat, ids, job || out.slice(0, 80));
        return ok(job ? `Queued ${job}. ${out}` : out);
      },
    }),
  ];
}
