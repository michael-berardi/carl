// Carl's own tools. Everything else comes from Pi (read, bash, edit, write), skills, extensions and MCP.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Psyche } from "./psyche.ts";
import type { Scheduler } from "./scheduler.ts";

export interface Outbox {
  /** Deliver text to a chat ("home" = the configured home chat). Returns a short receipt. */
  send(target: string, text: string): Promise<string>;
}

const ok = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });

export function carlTools(psyche: Psyche, scheduler: Scheduler, outbox: Outbox): ToolDefinition[] {
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
      "Own a failure in the open: record something you got wrong, avoided, or claimed without evidence. It feeds the daily individuation pass that turns failures into lessons. Use it the moment you notice, not to apologise.",
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
          scheduler.setEnabled(need(p.id), p.action === "resume");
          return ok(p.action === "pause" ? "Paused." : "Resumed.");
        case "run": {
          const job = scheduler.get(need(p.id)); // throws, naming the id, when there is no such job
          void scheduler.runNow(job.id).catch(() => {});
          return ok(`Started ${job.name}; the result is delivered when it finishes.`);
        }
      }
      throw new Error(`unknown action ${p.action}`);
    },
  });

  return [decisionLog, shadowNote, sendMessage, schedule] as ToolDefinition[];
}

function need(id: string | undefined): string {
  if (!id) throw new Error("this action needs id");
  return id;
}
