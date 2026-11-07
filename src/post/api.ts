// The gateway's side of `carl post`: POST /carl/post {cmd, draft, ...}. The CLI is only a client of this. Nothing here posts on a
// caller's say-so: `now`, `approve`, `clear-pending` and `record-live` raise an operator card (cards.ts) and answer "asked"; a post,
// an approval or a recorded click happens only after the operator presses that card on their channel, inside this process.
import type { PostService } from "./service.ts";
import { PostError } from "./types.ts";

export interface PostApiRequest {
  cmd: string;
  draft?: string;
  url?: string;
  at?: string;
  late?: string;
  skipDryRun?: boolean;
  offline?: boolean;
}
export interface PostApiReply { ok: boolean; text: string; final?: boolean }

export async function handlePost(svc: PostService, req: PostApiRequest): Promise<PostApiReply> {
  try {
    const need = () => { if (!req.draft) throw new PostError(`carl post ${req.cmd}: give the draft name or path`, true); return req.draft; };
    switch (req.cmd) {
      case "status": return { ok: true, text: svc.status() };
      case "dry-run": return { ok: true, text: await svc.dryRun(need(), { offline: req.offline }) };
      case "now": return { ok: true, text: svc.requestCard("post-now", need(), { by: "api", skipDryRun: req.skipDryRun }) };
      case "approve":
      case "clear-pending": return { ok: true, text: svc.requestCard(req.cmd, need(), { by: "api" }) };
      case "record-live":
        if (!req.url) throw new PostError("carl post record-live <draft> <url>: give the post's URL", true);
        return { ok: true, text: svc.requestCard("record-live", need(), { by: "api", url: req.url }) };
      case "schedule": {
        if (!req.at) throw new PostError("carl post schedule needs --at <ISO time>", true);
        if (req.late !== undefined && req.late !== "post" && req.late !== "skip") throw new PostError('--late is "post" or "skip"', true);
        return { ok: true, text: (await svc.schedule(need(), req.at, { late: req.late as "post" | "skip" | undefined, api: true, skipDryRun: req.skipDryRun })).text };
      }
    }
    throw new PostError(`unknown post command "${req.cmd}"`, true);
  } catch (e) {
    return { ok: false, text: (e as Error).message, final: e instanceof PostError && e.final };
  }
}
