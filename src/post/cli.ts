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
import { visible } from "./draft.ts";
import { PostService } from "./service.ts";
import { PostError } from "./types.ts";

export const POST_HELP = `carl post <command>

  dry-run <draft> [--offline]     render, validate and prove the platform takes the exact text, then discard it (no approval needed)
  now <draft> [--skip-dry-run]    post it now (needs your approval of the current text and a live dry run of it)
  schedule <draft> --at <ISO> [--late post] [--skip-dry-run]
                                  post it at that time; a slot missed by more than the window is skipped unless --late post
  approve <draft> [--by <name>]   record your approval of the draft's current text (asks at a terminal)
  clear-pending <draft>           after checking the account: a click was started on a part and never recorded, and that part is NOT live
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
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { offline: { type: "boolean" }, at: { type: "string" }, late: { type: "string" }, by: { type: "string" }, "skip-dry-run": { type: "boolean" } } });
    const svc = make?.() ?? defaultService();
    const draft = positionals[0];
    const need = () => { if (!draft) throw new PostError(`carl post ${sub}: give the draft name or path`, true); return draft; };
    switch (sub) {
      case "dry-run":
        io.out(await svc.dryRun(need(), { offline: values.offline }));
        return 0;
      case "now":
        io.out(await svc.postNow(need(), { skipDryRun: values["skip-dry-run"] }));
        return 0;
      case "schedule": {
        if (!values.at) throw new PostError("carl post schedule needs --at <ISO time>", true);
        if (values.late !== undefined && values.late !== "post" && values.late !== "skip") throw new PostError('--late is "post" or "skip"', true);
        io.out((await svc.schedule(need(), values.at, { late: values.late as "post" | "skip" | undefined, skipDryRun: values["skip-dry-run"] })).text);
        return 0;
      }
      case "approve": {
        if (!io.isTTY()) throw new PostError("carl post approve is operator-only: run it yourself in a terminal (it will not run from an agent or a script)", true);
        const d = svc.load(need());
        const { rendered } = svc.prepare(d);
        // What is shown is what is approved: the hash of this read is passed to approve(), which refuses if the file differs by then.
        const shown = d.textHash;
        const live = d.partHashes.length;
        io.out(`Approve posting to ${d.platform}/${d.account} (${svc.deps.config.accounts[d.account]?.profile}):\n\n${rendered.sequence.map((t, i) => `[${i + 1}]${i < live ? " (ALREADY LIVE, cannot be changed)" : ""} ${visible(t)}`).join("\n\n")}\n`);
        if (!(await io.confirm("Approve exactly this text? [y/N] "))) { io.out("Not approved."); return 1; }
        io.out(await svc.approve(draft!, values.by?.trim() || userInfo().username, shown));
        return 0;
      }
      case "clear-pending": {
        if (!io.isTTY()) throw new PostError("carl post clear-pending is operator-only: run it yourself in a terminal", true);
        const d = svc.load(need());
        if (d.pendingPart === undefined) { io.out(`${draft} has no pending part.`); return 0; }
        io.out(`A click on part ${d.pendingPart + 1} of ${draft} was started${d.pendingAt ? ` at ${d.pendingAt}` : ""} and never recorded. Open ${svc.deps.config.accounts[d.account]?.profile} and look.`);
        if (!(await io.confirm(`Is part ${d.pendingPart + 1} certainly NOT live? Clearing lets Carl post it again. [y/N] `))) { io.out("Left pending."); return 1; }
        io.out(await svc.clearPending(draft!));
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
  const scheduler = new Scheduler(cfg.home, new Log(undefined), { prompt: async () => "", builtin: {}, deliver: async () => {} }, { passive: true });
  return new PostService({ home: cfg.home, config: cfg.post, run: realRunner, registry: defaultRegistry(), scheduler });
}
