import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Feedback } from "../src/feedback.ts";
import type { CarlConfig } from "../src/config.ts";
import type { Log } from "../src/log.ts";

test("feedback pages, retries, acknowledges only queued work and keeps personal data out of logs", async () => {
  const home = mkdtempSync(join(tmpdir(), "feedback-test-")); mkdirSync(join(home, "state"));
  const script = join(home, "queue.cjs"); const inputs = join(home, "inputs"); const fail = join(home, "fail");
  writeFileSync(script, `const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(inputs)},s+'\\n');if(fs.existsSync(${JSON.stringify(fail)})){console.error('private@example.com');process.exit(1)}console.log('job-1')})`);
  const notices: string[] = []; const logs: string[] = []; const ack: string[] = []; const after: string[] = []; let failAck = false;
  const item = (id: string) => ({ id, site: "example", kind: "bug", message: "private@example.com", pageUrl: `http://127.0.0.1:${port}/`, email: "private@example.com", createdAt: "2026-01-01", context: { private: "private@example.com" } });
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-token");
    if (req.method === "POST") { let body = ""; req.on("data", c => body += c); req.on("end", () => { if (failAck) { failAck = false; res.statusCode = 503; res.end("{}"); return; } assert.equal(JSON.parse(body).ref, "job-1"); ack.push(JSON.parse(body).ids[0]); res.end("{}"); }); return; }
    const cursor = new URL(req.url!, "http://example.com").searchParams.get("after")!; after.push(cursor);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(cursor ? { items: [item("2")], next: null } : { items: [item("1")], next: "cursor-1" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const cfg = { home, envFiles: [], work: { command: [process.execPath, script] }, feedback: { intervalMinutes: 15, sources: [{ name: "example", url: `http://127.0.0.1:${port}/feed`, tokenEnv: "EXAMPLE_FEEDBACK_TEST_TOKEN", project: "example", chat: "example" }] } } as unknown as CarlConfig;
  const log = { error: (...args: unknown[]) => logs.push(JSON.stringify(args)) } as unknown as Log;
  const feedback = new Feedback(cfg, log, async (_target, text) => { notices.push(text); });
  const clock = Date.now; let now = clock(); Date.now = () => now;
  try {
    delete process.env.EXAMPLE_FEEDBACK_TEST_TOKEN; await feedback.tick(); await feedback.tick(); assert.equal(logs.length, 1);
    process.env.EXAMPLE_FEEDBACK_TEST_TOKEN = "test-token"; writeFileSync(fail, "");
    for (let i = 0; i < 5; i++) { await feedback.tick(); now += 4_000_000; }
    assert.deepEqual(ack, []); assert.equal(logs.length, 2); assert.equal(notices.length, 1); assert.ok(!logs.join().includes("private@example.com")); assert.ok(!logs.join().includes("test-token"));
    const attempts = readFileSync(inputs, "utf8").trim().split("\n").length; assert.equal(attempts, 5); now -= 3_999_999; await feedback.tick(); assert.equal(readFileSync(inputs, "utf8").trim().split("\n").length, attempts);
    now += 4_000_000; rmSync(fail); failAck = true; await feedback.tick(); assert.deepEqual(ack, []);
    const queued = readFileSync(inputs, "utf8").trim().split("\n").length;
    now += 60_001; await new Feedback(cfg, log, async (_target, text) => { notices.push(text); }).tick(); assert.deepEqual(ack, ["1", "2"]); assert.equal(readFileSync(inputs, "utf8").trim().split("\n").length, queued + 1); assert.ok(after.includes("cursor-1"));
    const req = JSON.parse(readFileSync(inputs, "utf8").trim().split("\n")[0]); assert.equal(req.siteItem.email, "private@example.com"); assert.match(req.request, /private@example.com/);
  } finally { Date.now = clock; delete process.env.EXAMPLE_FEEDBACK_TEST_TOKEN; await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

test("feedback config validates every source field and requires sandboxed work", async () => {
  const { loadConfig, ConfigError } = await import("../src/config.ts");
  const home = mkdtempSync(join(tmpdir(), "feedback-config-"));
  const source = { name: "example", url: "https://example.com/feed/", tokenEnv: "TOKEN", project: "example" };
  const check = (feedback: unknown, work: unknown, message: RegExp) => {
    writeFileSync(join(home, "carl.json"), JSON.stringify({ feedback, work, api: { enabled: false } }));
    assert.throws(() => loadConfig(home), (e: Error) => e instanceof ConfigError && message.test(e.message));
  };
  const work = { command: [process.execPath], sandboxed: true };
  try {
    check({ sources: [source] }, undefined, /feedback needs work.command/);
    check({ sources: [source] }, { command: [process.execPath] }, /feedback needs work.sandboxed: true/);
    check({}, work, /feedback.sources/); check({ sources: [] }, work, /feedback.sources/);
    check({ sources: [null] }, work, /sources\[0\].name/);
    check({ sources: [source, source] }, work, /sources\[1\].name/);
    for (const key of ["url", "tokenEnv", "project"]) check({ sources: [{ ...source, [key]: "" }] }, work, new RegExp(`sources\\[0\\].${key} is required`));
    for (const [patch, pattern] of [
      [{ name: "bad name" }, /name/], [{ url: "not a url" }, /url/], [{ url: "ftp://example.com" }, /url/],
      [{ url: "https://user@example.com" }, /url/], [{ url: "https://example.com/?x=1" }, /url/],
      [{ url: "http://example.com" }, /HTTPS/], [{ tokenEnv: "1BAD" }, /tokenEnv/], [{ project: "Bad" }, /project/],
      [{ chat: "" }, /chat/], [{ chat: 1 }, /chat/], [{ instructions: 1 }, /instructions/],
    ] as const) check({ sources: [{ ...source, ...patch }] }, work, pattern);
    check({ intervalMinutes: 0, sources: [source] }, work, /intervalMinutes/);
    writeFileSync(join(home, "carl.json"), JSON.stringify({ feedback: { sources: [source] }, work }));
    assert.equal(loadConfig(home).feedback?.sources[0].url, "https://example.com/feed");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("invalid items do not block valid items on a page; cycles and corrupt state are safely logged", async () => {
  const home = mkdtempSync(join(tmpdir(), "feedback-pages-"));
  const logs: string[] = []; const notices: string[] = []; const acks: string[] = [];
  const script = join(home, "queue.cjs"); writeFileSync(script, "process.stdin.resume();process.stdin.on('end',()=>console.log('job-1'))");
  let mode = "invalid"; let port = 0; let polls = 0;
  const server = createServer((req, res) => {
    if (req.method === "POST") { let body = ""; req.on("data", c => body += c); req.on("end", () => { acks.push(JSON.parse(body).ids[0]); res.end("{}"); }); return; }
    polls++; const cursor = new URL(req.url!, "http://example.com").searchParams.get("after");
    const good = { id: "good", site: "example", kind: "bug", message: "hello", pageUrl: `http://127.0.0.1:${port}/page`, createdAt: "today" };
    if (mode === "invalid") res.end(JSON.stringify({ items: [{ ...good, id: "bad", pageUrl: "https://example.com/" }, good], next: "later" }));
    else if (mode === "same") res.end(JSON.stringify({ items: [], next: cursor || "first" }));
    else res.end(JSON.stringify({ items: [good], next: cursor === "a" ? "b" : "a" }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); port = (server.address() as { port: number }).port;
  const cfg = { home, envFiles: [], work: { command: [process.execPath, script] }, feedback: { intervalMinutes: 1, sources: [{ name: "example", url: `http://127.0.0.1:${port}/feed`, tokenEnv: "FEEDBACK_PAGE_TOKEN", project: "example", chat: "example" }] } } as unknown as CarlConfig;
  const log = { error: (...args: unknown[]) => logs.push(JSON.stringify(args)) } as unknown as Log;
  const feedback = new Feedback(cfg, log, async (_target, text) => { notices.push(text); });
  const clock = Date.now; let now = clock(); Date.now = () => now; process.env.FEEDBACK_PAGE_TOKEN = "secret-token";
  try {
    for (let i = 0; i < 5; i++) { await feedback.tick(); now += 4_000_000; }
    assert.deepEqual(acks, ["good"]); assert.equal(notices.length, 1); assert.match(logs.join(), /invalid feedback item/);
    const files = await import("node:fs"); const state = files.readdirSync(join(home, "state")).find(n => n.endsWith(".json"))!;
    assert.equal(JSON.parse(readFileSync(join(home, "state", state), "utf8")).cursor, undefined);
    rmSync(join(home, "state"), { recursive: true }); mode = "same"; await feedback.tick(); const before = polls; await feedback.tick(); assert.equal(polls, before + 1);
    rmSync(join(home, "state"), { recursive: true }); mode = "cycle"; await feedback.tick(); assert.match(logs.join(), /feedback cursor cycle/);
    rmSync(join(home, "state"), { recursive: true }); mkdirSync(join(home, "state")); writeFileSync(join(home, "state", state), "{"); await feedback.tick(); assert.match(logs.join(), /feedback state cannot be read/);
    assert.ok(!logs.join().includes("secret-token"));
  } finally { Date.now = clock; delete process.env.FEEDBACK_PAGE_TOKEN; await new Promise<void>(r => server.close(() => r())); rmSync(home, { recursive: true, force: true }); }
});

test("source errors back off, notify once, reject oversized pages, and concurrent ticks do not overlap", async () => {
  const home = mkdtempSync(join(tmpdir(), "feedback-health-"));
  let hits = 0, mode = "error"; const notices: string[] = [], logs: string[] = [];
  let release: (() => void) | undefined;
  const server = createServer((_req, res) => {
    hits++;
    if (mode === "error") { res.statusCode = 503; res.end(); }
    else if (mode === "oversize") res.end(JSON.stringify({ items: Array(51).fill(null), next: null }));
    else release = () => res.end(JSON.stringify({ items: [], next: null }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const port = (server.address() as { port: number }).port;
  const cfg = { home, envFiles: [], work: { command: [process.execPath] }, feedback: { sources: [{ name: "example", url: `http://127.0.0.1:${port}/feed`, tokenEnv: "FEEDBACK_HEALTH_TOKEN", project: "example", chat: "example" }] } } as unknown as CarlConfig;
  const log = { error: (...a: unknown[]) => logs.push(JSON.stringify(a)) } as unknown as Log;
  const f = new Feedback(cfg, log, async (_t, text) => { notices.push(text); });
  const clock = Date.now; let now = clock(); Date.now = () => now; process.env.FEEDBACK_HEALTH_TOKEN = "secret-token";
  try {
    for (let i = 0; i < 5; i++) { await f.tick(); const count = hits; await f.tick(); assert.equal(hits, count); now += 4_000_000; }
    assert.equal(hits, 5); assert.equal(notices.length, 1); assert.match(logs.join(), /feed HTTP 503/); assert.ok(!logs.join().includes("secret-token"));
    mode = "oversize"; await f.tick(); assert.equal(notices.length, 1); assert.match(logs.join(), /invalid feed response/); now += 4_000_000;
    mode = "wait"; const pending = f.tick(); while (!release) await new Promise(r => setTimeout(r, 1)); const before = hits;
    await f.tick(); assert.equal(hits, before); release(); await pending;
  } finally { Date.now = clock; delete process.env.FEEDBACK_HEALTH_TOKEN; await new Promise<void>(r => server.close(() => r())); rmSync(home, { recursive: true, force: true }); }
});
