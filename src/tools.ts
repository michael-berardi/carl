// Carl's own tools. Everything else comes from Pi (read, bash, edit, write), skills, extensions and MCP.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Psyche } from "./psyche.ts";
import type { Scheduler } from "./scheduler.ts";
import type { PostService } from "./post/service.ts";

export interface Outbox {
  /** Deliver text to a chat ("home" = the configured home chat). Returns a short receipt. */
  send(target: string, text: string): Promise<string>;
}

const ok = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });

export function carlTools(psyche: Psyche, scheduler: Scheduler, outbox: Outbox, post?: PostService): ToolDefinition[] {
  const decisionLog = defineTool({
    name: "decision_log",
    label: "Decision log",
    description:
      "The operator's decision record (the mirror's memory). action=record: log a decision they made, with rationale and the outcome they expect. action=outcome: attach what actually happened to a decision id. action=list: recent decisions with outcomes, to reflect them back honestly.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("record"), Type.Literal("outcome"), Type.Literal("list")]),
      decision: Type.Optional(Type.String({ description: "record: the decision, in one sentence" })),
      rationale: Type.Optional(Type.String()),
      expected: Type.Optional(Type.String({ description: "record: the outcome they expect" })),
      id: Type.Optional(Type.String({ description: "outcome: decision id" })),
      outcome: Type.Optional(Type.String({ description: "outcome: what actually happened" })),
      limit: Type.Optional(Type.Number({ description: "list: how many (default 20)" })),
    }),
    async execute(_id, p) {
      if (p.action === "record") {
        if (!p.decision) throw new Error("record needs decision");
        const d = psyche.recordDecision({ decision: p.decision, rationale: p.rationale, expected: p.expected });
        return ok(`Recorded ${d.id}.`, d);
      }
      if (p.action === "outcome") {
        if (!p.id || !p.outcome) throw new Error("outcome needs id and outcome");
        const d = psyche.recordOutcome(p.id, p.outcome);
        if (!d) throw new Error(`no decision with id ${p.id}`);
        return ok(`Outcome attached to ${d.id}.`, d);
      }
      const list = psyche.decisions(p.limit ?? 20);
      if (!list.length) return ok("No decisions recorded yet.");
      return ok(list.map((d) => `${d.id} ${d.at.slice(0, 10)} ${d.decision}${d.expected ? ` | expected: ${d.expected}` : ""}${d.outcome ? ` | outcome: ${d.outcome}` : " | outcome: (open)"}`).join("\n"));
    },
  });

  const shadowNote = defineTool({
    name: "shadow_note",
    label: "Shadow note",
    description:
      `Own a failure in the open: record something you got wrong, avoided, or claimed without evidence. It feeds ${psyche.learning === "ultraterm" ? "UltraTerm Dream and Nightmare, which turn failures into shared lessons and fixes" : "the daily individuation pass that turns failures into lessons"}. Use it the moment you notice, not to apologise.`,
    parameters: Type.Object({
      summary: Type.String({ description: "What went wrong, in one sentence" }),
      evidence: Type.Optional(Type.String({ description: "The concrete evidence (command output, the claim, the correction)" })),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      psyche.recordShadow({ kind: "admission", conversation: (ctx as any)?.sessionManager?.getSessionId?.() ?? "unknown", summary: p.summary, evidence: p.evidence });
      return ok("Noted in the shadow ledger.");
    },
  });

  const sendMessage = defineTool({
    name: "send_message",
    label: "Send message",
    description:
      "Send a message now, outside the current reply: progress on long work, an alert, or a result to the operator's home chat. target is \"home\" or a Telegram chat id. Your normal reply already reaches the current chat; do not duplicate it.",
    parameters: Type.Object({
      target: Type.String({ description: '"home" or a numeric chat id' }),
      text: Type.String({ description: "Markdown text" }),
    }),
    async execute(_id, p) {
      return ok(await outbox.send(p.target, p.text));
    },
  });

  const schedule = defineTool({
    name: "schedule",
    label: "Schedule",
    description:
      'Recurring or one-off work. action=list|add|remove|run|pause|resume. add needs name, when ("every 30m", "0 9 * * 1-5", "@daily", or "once 2026-10-16T09:00") and prompt (the instruction for a fresh agent run; its tools follow the same approval rules as yours, and unattended runs cannot get approvals). Results go to deliver ("home" default, "none", or a chat id). Shell-command schedules are created by the operator in the web portal, not by you.',
    parameters: Type.Object({
      action: Type.Union(["list", "add", "remove", "run", "pause", "resume"].map((a) => Type.Literal(a))),
      id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      when: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      deliver: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      switch (p.action) {
        case "list":
          return ok(scheduler.describe());
        case "add": {
          if (!p.name || !p.when || !p.prompt) throw new Error("add needs name, when and prompt");
          const job = scheduler.add({ name: p.name, when: p.when, prompt: p.prompt, deliver: p.deliver ?? "home" });
          return ok(`Scheduled ${job.id} (${job.when}); next run ${new Date(job.nextRunAt!).toLocaleString()}.`);
        }
        case "remove":
          return ok(scheduler.remove(need(p.id)) ? "Removed." : `No job ${p.id}.`);
        case "pause":
        case "resume":
          // A post job is the operator's: resuming one would fire it, so only the operator (`carl post`, the portal) can.
          if (p.action === "resume" && scheduler.get(need(p.id)).post) throw new Error("that is a scheduled post: only the operator can resume or run it (`carl post schedule`)");
          scheduler.setEnabled(need(p.id), p.action === "resume");
          return ok(p.action === "pause" ? "Paused." : "Resumed.");
        case "run": {
          const job = scheduler.get(need(p.id)); // throws, naming the id, when there is no such job
          if (job.post) throw new Error("that is a scheduled post: only the operator can run it early (a post fires at its slot, never on the agent's request)");
          void scheduler.runNow(job.id).catch(() => {});
          return ok(`Started ${job.name}; the result is delivered when it finishes.`);
        }
      }
      throw new Error(`unknown action ${p.action}`);
    },
  });

  // Drafting, dry runs and scheduling only. There is deliberately no way to approve or to post at once from here: the
  // operator approves a draft's text by answering its card on their own channel (the agent may only request the card), and
  // scheduling refuses a draft without that approval.
  const postDraft = post && defineTool({
    name: "post_draft",
    label: "Post draft",
    description:
      'Social posts. action=draft: write a new draft (name, platform, account, and text or thread parts, optional reply); action=dry_run: render and validate a draft, and with offline=false also check the platform takes the exact text, posting nothing; action=schedule: give an approved draft its first slot at an ISO time (only when it has no slot yet; at least 15 minutes ahead, and the operator is told; a slot missed by more than the configured window is skipped; you cannot change a slot or post late); action=request_approval: put the draft in front of the operator as a card on their channel (you cannot answer it); action=status. For scheduling the draft also needs a live dry run of its exact text (dry_run with offline=false). You cannot approve a draft, post one now, or run or resume a scheduled post: the operator approves the exact text by answering its card on their own channel (request_approval or `carl post approve` only creates the card), and scheduling refuses a draft that is not approved or was edited after approval. Accounts come from the operator\'s configuration.',
    parameters: Type.Object({
      action: Type.Union(["draft", "dry_run", "request_approval", "schedule", "status"].map((a) => Type.Literal(a))),
      name: Type.Optional(Type.String({ description: "draft name: lowercase letters, digits, . _ -" })),
      platform: Type.Optional(Type.String()),
      account: Type.Optional(Type.String({ description: "an account key from the operator's configuration" })),
      text: Type.Optional(Type.String()),
      thread: Type.Optional(Type.Array(Type.String(), { description: "thread parts, in order (instead of text)" })),
      reply: Type.Optional(Type.String({ description: "first reply under a single post" })),
      at: Type.Optional(Type.String({ description: "schedule: ISO time" })),
      offline: Type.Optional(Type.Boolean({ description: "dry_run: only render and validate (default true); false also fills the composer in the browser and records the dry run, posting nothing" })),
    }),
    async execute(_id, p) {
      switch (p.action) {
        case "draft":
          if (!p.name || !p.platform || !p.account) throw new Error("draft needs name, platform, account and text or thread");
          return ok(post.createDraft({ name: p.name, platform: p.platform, account: p.account, text: p.text, thread: p.thread, reply: p.reply }));
        case "dry_run":
          return ok(await post.dryRun(need(p.name), { offline: p.offline ?? true, named: true }));
        case "request_approval":
          return ok(post.requestCard("approve", need(p.name), { named: true, by: "agent" }));
        case "schedule":
          if (!p.name || !p.at) throw new Error("schedule needs name and at");
          if ((p as { late?: unknown }).late !== undefined) throw new Error("you cannot choose late posting; the operator does");
          return ok((await post.schedule(p.name, p.at, { named: true, agent: true })).text);
        case "status":
          return ok(post.status());
      }
      throw new Error(`unknown action ${p.action}`);
    },
  });

  return [decisionLog, shadowNote, sendMessage, schedule, ...(postDraft ? [postDraft] : [])] as ToolDefinition[];
}

function need(id: string | undefined): string {
  if (!id) throw new Error("this action needs id");
  return id;
}
