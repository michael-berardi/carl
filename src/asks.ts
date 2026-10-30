// Asks: Carl puts questions to a person in a chat, collects the answers, and hands them to whatever waits on
// them. Off unless `asks` is set in carl.json. One ask is one JSON file in CARL_HOME/asks/:
//
//   { "id": "lucero-publication", "chat": -5269168638, "askee": "Kate",
//     "title": "Before the new pages go live", "questions": [{"n": 1, "text": "..."}],
//     "answersFile": "/abs/answers.md", "onComplete": ["ut-overseer", "job-report", "--json", "{...}"] }
//
// The operator (or a coordinator acting for them) writes the file; `carl ask-post <id>` posts the questions.
// The agent can only record answers and finish an ask: finishing writes the answers file and runs the ask's
// own onComplete argv (no shell), which the agent cannot change. Errors name their cause.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export interface Ask {
  id: string;
  chat: number;
  askee: string;
  title: string;
  intro?: string;
  questions: { n: number; text: string }[];
  answersFile: string;
  onComplete?: string[];
  answers: Record<string, { text: string; by: string; at: string }>;
  status: "draft" | "open" | "done";
  postedMessageId?: number;
  finishedAt?: string;
  completion?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export class Asks {
  readonly dir: string;
  constructor(home: string) {
    this.dir = join(home, "asks");
  }

  private path(id: string): string {
    if (!ID.test(id)) throw new Error(`ask id "${id}" must be letters, digits, ".", "_" or "-"`);
    return join(this.dir, `${id}.json`);
  }

  load(id: string): Ask {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`no ask "${id}" in ${this.dir}`);
    let a: Partial<Ask>;
    try { a = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new Error(`ask file ${p} is not valid JSON: ${(e as Error).message}`); }
    return validate({ ...a, answers: a.answers ?? {}, status: a.status ?? "draft" } as Ask);
  }

  save(a: Ask): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = this.path(a.id);
    writeFileSync(`${p}.tmp`, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
  }

  open(): Ask[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
      try { const a = this.load(f.slice(0, -5)); return a.status === "open" ? [a] : []; } catch { return []; }
    });
  }

  /** Is an open ask in this chat waiting on this member? Matches the askee to the member's configured name. */
  waitingOn(chat: number, member: string): boolean {
    const name = member.toLowerCase();
    return this.open().some((a) => a.chat === chat && (name === a.askee.toLowerCase() || name.startsWith(`${a.askee.toLowerCase()} `)));
  }

  /** The message that puts the questions to the askee. */
  static message(a: Ask): string {
    const lines = [`**${a.title}**`, ""];
    if (a.intro) lines.push(a.intro, "");
    for (const q of a.questions) lines.push(`${q.n}. ${q.text}`);
    lines.push("", `${a.askee}, reply to this message with the numbers and your answers, in English or Spanish. One message or several is fine.`);
    return lines.join("\n");
  }

  static summary(a: Ask): string {
    const out = [`Ask ${a.id} (${a.status}) to ${a.askee} in chat ${a.chat}: ${a.title}`];
    for (const q of a.questions) {
      const ans = a.answers[String(q.n)];
      out.push(`${q.n}. ${q.text}`, ans ? `   -> ${ans.text} (${ans.by}, ${ans.at})` : "   -> (no answer yet)");
    }
    const missing = a.questions.filter((q) => !a.answers[String(q.n)]).map((q) => q.n);
    out.push(missing.length ? `Unanswered: ${missing.join(", ")}` : "Every question has an answer: finish it with ask_finish.");
    return out.join("\n");
  }

  record(id: string, n: number, text: string, by: string): Ask {
    const a = this.load(id);
    if (a.status !== "open") throw new Error(`ask ${id} is ${a.status}, not open`);
    if (!a.questions.some((q) => q.n === n)) throw new Error(`ask ${id} has no question ${n}`);
    if (!text.trim()) throw new Error("the answer is empty: record what was actually said");
    if (!by.trim()) throw new Error("answered_by is empty: name who answered");
    a.answers[String(n)] = { text: text.trim(), by: by.trim(), at: new Date().toISOString() };
    this.save(a);
    return a;
  }

  async finish(id: string, note = ""): Promise<string> {
    const a = this.load(id);
    if (a.status !== "open") throw new Error(`ask ${id} is already ${a.status}`);
    const missing = a.questions.filter((q) => !a.answers[String(q.n)]).map((q) => q.n);
    if (missing.length) throw new Error(`questions ${missing.join(", ")} have no answer yet; ask again (an explicit "skip" counts as an answer)`);
    const md = [`# ${a.title}`, "", `Answers from ${a.askee} (Telegram chat ${a.chat}), collected by Carl, ${new Date().toISOString()}.`, ""];
    for (const q of a.questions) {
      const ans = a.answers[String(q.n)];
      md.push(`## ${q.n}. ${q.text}`, "", `${ans.by} (${ans.at}): ${ans.text}`, "");
    }
    if (note.trim()) md.push("## Note", "", note.trim(), "");
    mkdirSync(dirname(a.answersFile), { recursive: true, mode: 0o700 });
    writeFileSync(a.answersFile, md.join("\n"), { mode: 0o600 });
    chmodSync(a.answersFile, 0o600);
    let completion = "";
    if (a.onComplete?.length) {
      const [cmd, ...args] = a.onComplete;
      completion = await new Promise<string>((resolve, reject) => {
        execFile(cmd, args, { timeout: 120_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
          if (err) reject(new Error(`answers saved to ${a.answersFile}, but onComplete failed (${cmd}): ${(stderr || stdout || err.message).trim().slice(0, 500)}`));
          else resolve(stdout.trim().slice(0, 500));
        });
      });
    }
    a.status = "done";
    a.finishedAt = new Date().toISOString();
    a.completion = completion;
    this.save(a);
    return `Answers saved to ${a.answersFile}.${a.onComplete?.length ? " The waiting work was started." : ""}`;
  }
}

function validate(a: Ask): Ask {
  const where = `ask ${a.id}`;
  if (!Number.isSafeInteger(a.chat)) throw new Error(`${where}: chat must be a Telegram chat id`);
  if (!a.askee?.trim() || !a.title?.trim()) throw new Error(`${where}: askee and title are required`);
  if (!Array.isArray(a.questions) || !a.questions.length || a.questions.some((q) => !Number.isSafeInteger(q?.n) || !q.text?.trim()))
    throw new Error(`${where}: questions must be a non-empty list of {n, text}`);
  if (!a.answersFile || !isAbsolute(a.answersFile)) throw new Error(`${where}: answersFile must be an absolute path`);
  if (a.onComplete !== undefined && (!Array.isArray(a.onComplete) || !a.onComplete.length || a.onComplete.some((s) => typeof s !== "string")))
    throw new Error(`${where}: onComplete must be an argv list of strings`);
  return a;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

/** The agent's side: see open asks, record answers, finish. It cannot create asks or change what finishing runs. */
export function askTools(asks: Asks): ToolDefinition[] {
  return [
    defineTool({
      name: "ask_open",
      label: "Open asks",
      description: "Questions Carl has put to people and is waiting on: each question and the answers recorded so far. Check it when someone in a group answers or asks what is pending.",
      parameters: Type.Object({}),
      async execute() {
        const open = asks.open();
        return ok(open.length ? open.map((a) => Asks.summary(a)).join("\n\n") : "No open asks.");
      },
    }),
    defineTool({
      name: "ask_answer",
      label: "Record answer",
      description: "Record one answer to an open ask, faithful to what the person said (keep figures exact; translate only if needed). One call per answered question. If an answer is unclear, ask a follow-up in the chat instead of guessing.",
      parameters: Type.Object({
        ask: Type.String({ description: "ask id from ask_open" }),
        question: Type.Number({ description: "question number" }),
        answer: Type.String(),
        answered_by: Type.String({ description: "the sender named in the message" }),
      }),
      async execute(_id, p) {
        return ok(Asks.summary(asks.record(p.ask, p.question, p.answer, p.answered_by)));
      },
    }),
    defineTool({
      name: "ask_finish",
      label: "Finish ask",
      description: "When every question of an ask has an answer, finish it: saves the answers and starts the work waiting on them. Refused while any question is unanswered. Tell the person the work is starting.",
      parameters: Type.Object({
        ask: Type.String(),
        note: Type.Optional(Type.String({ description: "conditions or caveats the person added, for whoever does the work" })),
      }),
      async execute(_id, p) {
        return ok(await asks.finish(p.ask, p.note ?? ""));
      },
    }),
  ];
}

/** The asks module's tools when it is on, for every place that builds Carl's tool set (gateway, ask, prompt). */
export function moduleAskTools(cfg: { asks: boolean; home: string }, asks?: Asks): ToolDefinition[] {
  return cfg.asks ? askTools(asks ?? new Asks(cfg.home)) : [];
}
