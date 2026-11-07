// carl post dry-run|now|schedule|approve|clear-pending|record-live|status. approve, clear-pending and record-live do not decide
// anything here: they put a card (the exact text, account, profile and text hash) in front of the operator on their channel, and
// the gateway carries the action out only when the operator answers that card there. A terminal proves nothing (anything that can
// type into one can type "y"), so no answer is ever read from this process.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { Log } from "../log.ts";
import { Scheduler } from "../scheduler.ts";
import { defaultRegistry } from "./registry.ts";
import { realRunner } from "./runner.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sessionPrograms, sessionProblems } from "./key.ts";
import { PostService } from "./service.ts";
import { PostError } from "./types.ts";

export const POST_HELP = `carl post <command>

  dry-run <draft> [--offline]     render, validate and prove the platform takes the exact text, then discard it (no approval needed)
  now <draft> [--skip-dry-run]    post it now (needs your approval of the current text and a live dry run of it)
  schedule <draft> --at <ISO> [--late post] [--skip-dry-run]
                                  post it at that time; a slot missed by more than the window is skipped unless --late post
  approve <draft>                 ask for your approval: a card with the exact text appears on your operator channel (Telegram); the approval is recorded only when you answer it there
  clear-pending <draft>           same, for: a click was started on a part and never recorded, and that part is NOT live
  record-live <draft> <url>       same, for: the part after the recorded ones is already live at <url> (this account's status)
  status                          drafts, scheduled posts, cards waiting for you, and any session-command problem

<draft> is a name in the drafts folder (post.draftsDir) or a path.`;

export interface PostCliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

const realIo: PostCliIo = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

export async function postCommand(args: string[], io: PostCliIo = realIo, make?: () => PostService): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help") { io.out(POST_HELP); return sub ? 0 : 64; }
  try {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { offline: { type: "boolean" }, at: { type: "string" }, late: { type: "string" }, "skip-dry-run": { type: "boolean" } } });
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
      case "approve":
      case "clear-pending":
        io.out(svc.requestCard(sub, need(), { by: "operator" }));
        return 0;
      case "record-live": {
        const url = positionals[1];
        if (!url) throw new PostError("carl post record-live <draft> <url>: give the post's URL", true);
        io.out(svc.requestCard("record-live", need(), { by: "operator", url }));
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
  return new PostService({ home: cfg.home, config: cfg.post, run: realRunner, registry: defaultRegistry(), scheduler, sessionProblems: () => sessionProblems(cfg.post.accounts, found(cfg.post.accounts)) });
}

/** Where each configured session command is on this process's own PATH (the CLI runs with the operator's PATH). */
function found(accounts: Record<string, { session: { command: string } }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(sessionPrograms(accounts))) {
    const path = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, name)).find((c) => existsSync(c));
    if (path) out[name] = path;
  }
  return out;
}
