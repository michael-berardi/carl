import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/hooks.ts";

test("webhook signatures: GitHub-style sha256 HMAC, constant-time, exact", () => {
  const body = Buffer.from('{"action":"opened"}');
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.ok(verifySignature(body, sig, "s3cret"));
  assert.ok(!verifySignature(body, sig, "other"));
  assert.ok(!verifySignature(Buffer.from('{"action":"closed"}'), sig, "s3cret"));
  assert.ok(!verifySignature(body, undefined, "s3cret"));
  assert.ok(!verifySignature(body, sig.replace("sha256=", "sha1="), "s3cret"));
});

async function fakes(home: string, hooks: Record<string, any>, answer: (text: string) => Promise<any>) {
  const { mountHooks } = await import("../src/hooks.ts");
  const routes: any[] = [];
  const sent: string[] = [];
  const asked: string[] = [];
  const api = { publicRoute: (_m: string, pattern: RegExp, handler: any) => routes.push({ pattern, handler }) };
  const gw: any = {
    cfg: { home, envFiles: [] },
    log: { info() {}, warn() {}, error() {} },
    brain: { reset: async () => {}, ask: async (_k: string, i: any) => { asked.push(i.text); return answer(i.text); } },
    send: async (_t: string, text: string) => { sent.push(text); return 1; },
  };
  const mounted = mountHooks(api as any, gw, hooks);
  const post = async (path: string, body: string, headers: Record<string, string> = {}) => {
    let status = 0, reply: any;
    const res: any = { statusCode: 0, setHeader() {}, writeHead(s: number) { status = s; }, end(d: string) { reply = JSON.parse(d); } };
    await routes[0].handler({ headers }, res, new URL("http://x" + path), Buffer.from(body), true);
    return { status: status || res.statusCode, reply };
  };
  return { mounted, post, sent, asked };
}

test("webhook deliveries are journaled before the 202, de-duplicated, and survive a restart", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { HookJournal } = await import("../src/hooks.ts");
  const home = mkdtempSync(join(tmpdir(), "carl-hooks-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const hooks = { gh: { prompt: "Handle {{payload}}", deliver: "home" } };

  // A run that never finishes: the process "dies" with the delivery in flight.
  const first = await fakes(home, hooks, () => new Promise(() => {}));
  const a = await first.post("/v1/hooks/gh", '{"n":1}', { "x-github-delivery": "d-1" });
  assert.equal(a.status, 202);
  const dup = await first.post("/v1/hooks/gh", '{"n":1}', { "x-github-delivery": "d-1" });
  assert.deepEqual([dup.status, dup.reply.duplicate, dup.reply.id], [200, true, a.reply.id], "a retried delivery is not run twice");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(first.asked.length, 1);
  first.mounted.journal.close();

  // An accepted delivery that never started, written straight into the journal (as if the crash came before the run).
  const raw = new HookJournal(join(home, "state", "hooks.db"));
  raw.accept("gh", "d-2", '{"n":2}');
  raw.close();

  // Restart: the one cut short is reported and not rerun; the one never started runs now.
  const second = await fakes(home, hooks, async () => ({ ok: true, text: "handled", aborted: false }));
  second.mounted.resume();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(second.asked.length, 1, "only the never-started delivery runs");
  assert.match(second.asked[0], /"n":2/);
  assert.ok(second.sent.some((s) => /interrupted by a restart/.test(s) && s.includes(a.reply.id)), "the cut-short delivery is reported");
  assert.ok(second.sent.some((s) => /handled/.test(s)), "the resumed delivery's result is delivered");
  assert.deepEqual(second.mounted.journal.pending(), [], "nothing is left pending");
  second.mounted.journal.close();
});
