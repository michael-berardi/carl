// carl post dry-run|now|schedule|approve|status. Approval is operator-only: it needs a terminal, so a command run by the
// agent (no TTY) cannot grant it, and the drafts folder is outside the agent's write areas.
import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { Log } from "../log.ts";
import { Scheduler } from "../scheduler.ts";
import { defaultRegistry } from "./registry.ts";
import { realRunner } from "./runner.ts";
import { PostService } from "./service.ts";
import { PostError } from "./types.ts";

export const POST_HELP = `carl post <command>

  dry-run <draft> [--offline]     render, validate and prove the platform takes the exact text, then discard it (no approval needed)
  now <draft>                     post it now (needs the operator's approval of the current text)
  schedule <draft> --at <ISO> [--late post]
                                  post it at that time; a slot missed by more than the window is skipped unless --late post
  approve <draft> [--by <name>]   record your approval of the draft's current text (asks at a terminal)
  status                          drafts and scheduled posts

<draft> is a name in the drafts folder (post.draftsDir) or a path.`;

export interface PostCliIo {
  isTTY: () => boolean;
  confirm: (question: string) => Promise<boolean>;
  out: (s: string) => void;
  err: (s: string) => void;
}

const realIo: PostCliIo = {
  isTTY: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
  confirm: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await rl.question(q)).trim()); } finally { rl.close(); }
  },
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

export async function postCommand(args: string[], io: PostCliIo = realIo, make?: () => PostService): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help") { io.out(POST_HELP); return sub ? 0 : 64; }
  try {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { offline: { type: "boolean" }, at: { type: "string" }, late: { type: "string" }, by: { type: "string" } } });
    const svc = make?.() ?? defaultService();
    const draft = positionals[0];
    const need = () => { if (!draft) throw new PostError(`carl post ${sub}: give the draft name or path`, true); return draft; };
    switch (sub) {
      case "dry-run":
        io.out(await svc.dryRun(need(), { offline: values.offline }));
        return 0;
      case "now":
        io.out(await svc.postNow(need()));
        return 0;
      case "schedule": {
        if (!values.at) throw new PostError("carl post schedule needs --at <ISO time>", true);
        if (values.late !== undefined && values.late !== "post" && values.late !== "skip") throw new PostError('--late is "post" or "skip"', true);
        io.out((await svc.schedule(need(), values.at, { late: values.late as "post" | "skip" | undefined })).text);
        return 0;
      }
      case "approve": {
        if (!io.isTTY()) throw new PostError("carl post approve is operator-only: run it yourself in a terminal (it will not run from an agent or a script)", true);
        const d = svc.load(need());
        const { rendered } = svc.prepare(d);
        io.out(`Approve posting to ${d.platform}/${d.account}:\n\n${rendered.sequence.map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}\n`);
        if (!(await io.confirm("Approve exactly this text? [y/N] "))) { io.out("Not approved."); return 1; }
        io.out(await svc.approve(draft, values.by?.trim() || userInfo().username));
        return 0;
      }
      case "status":
        io.out(svc.status());
        return 0;
    }
    io.err(`carl post: unknown command "${sub}"\n\n${POST_HELP}`);
    return 64;
  } catch (e) {
    io.err(`carl post: ${(e as Error).message}`);
    return e instanceof PostError && e.final ? 2 : 1;
  }
}

function defaultService(): PostService {
  const cfg = loadConfig();
  // Same schedules.json as the gateway; a running gateway adopts the job at its next tick.
  const scheduler = new Scheduler(cfg.home, new Log(undefined), { prompt: async () => "", builtin: {}, deliver: async () => {} });
  return new PostService({ home: cfg.home, config: cfg.post, run: realRunner, registry: defaultRegistry(), scheduler });
}
