// carl post dry-run|now|schedule|approve|clear-pending|record-live|status. This is only a client of the running gateway
// (POST /carl/post on 127.0.0.1 with CARL_API_KEY). It never posts, approves or records anything itself: the approval key lives in
// the gateway's memory alone. `now`, `approve`, `clear-pending` and `record-live` ask the gateway to put a card (the exact text,
// account, profile and text hash) in front of the operator on their channel; the gateway acts only when the operator presses it
// there. A terminal proves nothing (anything that can type into one can type "y"), so no answer is ever read from this process.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig, secret } from "../config.ts";
import type { PostApiReply, PostApiRequest } from "./api.ts";
export const POST_HELP = `carl post <command>

  dry-run <draft> [--offline]     render, validate and prove the platform takes the exact text, then discard it (no approval needed; run by the gateway)
  now <draft> [--skip-dry-run]    ask to post it now: a card appears on your operator channel and the gateway posts only when you press it there (needs a live dry run of the text)
  schedule <draft> --at <ISO> [--late post] [--skip-dry-run]
                                  post it at that time (needs a current approval, which lasts 24 h and ends when the gateway restarts); a slot missed by more than the window is skipped unless --late post
  approve <draft>                 ask for your approval: a card with the exact text appears on your operator channel (Telegram); the approval is recorded only when you answer it there
  clear-pending <draft>           same, for: a click was started on a part and never recorded, and that part is NOT live
  record-live <draft> <url>       same, for: the part after the recorded ones is already live at <url> (this account's status)
  status                          drafts, scheduled posts, cards waiting for you, and any session-command problem

<draft> is a name in the drafts folder (post.draftsDir) or a path. Every command except help talks to the running gateway.`;

export interface PostCliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Sends one request to the gateway; the real one is HTTP to 127.0.0.1 with the API key. */
export type PostApi = (req: PostApiRequest) => Promise<PostApiReply>;

const realIo: PostCliIo = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

/** A path given to the CLI is made absolute against the caller's folder (the gateway runs elsewhere); a bare name stays a name. */
function absoluteDraft(d: string | undefined): string | undefined {
  if (!d) return d;
  if (d.includes("/") || d.startsWith(".") || d.startsWith("~")) return d.startsWith("~") ? d : resolve(process.cwd(), d);
  return d;
}

export async function postCommand(args: string[], io: PostCliIo = realIo, api: PostApi = gatewayApi): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help") { io.out(POST_HELP); return sub ? 0 : 64; }
  if (!["dry-run", "now", "schedule", "approve", "clear-pending", "record-live", "status"].includes(sub)) {
    io.err(`carl post: unknown command "${sub}"\n\n${POST_HELP}`);
    return 64;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { offline: { type: "boolean" }, at: { type: "string" }, late: { type: "string" }, "skip-dry-run": { type: "boolean" } } });
    const req: PostApiRequest = { cmd: sub, draft: absoluteDraft(positionals[0]), url: sub === "record-live" ? positionals[1] : undefined, at: values.at, late: values.late, skipDryRun: values["skip-dry-run"], offline: values.offline };
    const reply = await api(req);
    (reply.ok ? io.out : io.err)(reply.ok ? reply.text : `carl post: ${reply.text}`);
    return reply.ok ? 0 : reply.final ? 2 : 1;
  } catch (e) {
    io.err(`carl post: ${(e as Error).message}`);
    return 1;
  }
}

async function gatewayApi(req: PostApiRequest): Promise<PostApiReply> {
  const cfg = loadConfig();
  if (!cfg.api.enabled) throw new Error("posting runs in the gateway and is reached over its API, but api.enabled is false in carl.json");
  const key = secret(cfg.home, cfg.api.keyEnv, cfg.envFiles);
  if (!key) throw new Error(`${cfg.api.keyEnv} is not set (environment or ${cfg.home}/.env): it is how this command asks the running gateway`);
  let res: Response;
  try {
    res = await fetch(`http://${cfg.api.host === "0.0.0.0" ? "127.0.0.1" : cfg.api.host}:${cfg.api.port}/carl/post`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(10 * 60_000) });
  } catch (e) {
    throw new Error(`the gateway is not reachable on ${cfg.api.host}:${cfg.api.port} (${(e as Error).message}); start it with \`carl gateway\`. Nothing was done`);
  }
  const body = (await res.json().catch(() => undefined)) as PostApiReply | { error?: { message?: string } } | undefined;
  if (body && "ok" in body) return body;
  throw new Error(`the gateway answered ${res.status}: ${(body as any)?.error?.message ?? "no message"}`);
}
