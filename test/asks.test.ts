import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asks, askTools } from "../src/asks.ts";
import { loadConfig } from "../src/config.ts";

function home(t: any) {
  const h = mkdtempSync(join(tmpdir(), "carl-asks-"));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  return h;
}

function write(h: string, extra: Record<string, unknown> = {}) {
  mkdirSync(join(h, "asks"), { recursive: true });
  const ask = { id: "pub", chat: -5269168638, askee: "Kate", title: "Before the pages go live", questions: [{ n: 1, text: "Fee?" }, { n: 2, text: "Notary first?" }], answersFile: join(h, "out", "answers.md"), status: "open", ...extra };
  writeFileSync(join(h, "asks", "pub.json"), JSON.stringify(ask));
}

const run = async (tools: any[], name: string, p: any) => (await tools.find((t) => t.name === name).execute("1", p)).content[0].text as string;

test("the asks module is off unless enabled", (t) => {
  const h = home(t);
  writeFileSync(join(h, "carl.json"), "{}");
  assert.equal(loadConfig(h).asks, false);
  writeFileSync(join(h, "carl.json"), JSON.stringify({ asks: true }));
  assert.equal(loadConfig(h).asks, true);
});

test("answers are recorded, an incomplete ask cannot finish, and finishing saves them and runs onComplete", async (t) => {
  const h = home(t);
  const marker = join(h, "completed");
  const script = join(h, "done.sh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(marker)}\necho released\n`);
  chmodSync(script, 0o755);
  write(h, { onComplete: [script, "J-1"] });
  const tools = askTools(new Asks(h));
  assert.match(await run(tools, "ask_open", {}), /Unanswered: 1, 2/);
  assert.match(await run(tools, "ask_answer", { ask: "pub", question: 1, answer: "USD 185 plus the USD 250 integrity fee", answered_by: "Kate" }), /Unanswered: 2/);
  await assert.rejects(run(tools, "ask_finish", { ask: "pub" }), /questions 2 have no answer/);
  await run(tools, "ask_answer", { ask: "pub", question: 2, answer: "Notary first", answered_by: "Kate" });
  assert.match(await run(tools, "ask_finish", { ask: "pub", note: "Kate prefers the notary route" }), /waiting work was started/);
  const md = readFileSync(join(h, "out", "answers.md"), "utf8");
  assert.match(md, /USD 185 plus the USD 250 integrity fee/);
  assert.match(md, /Kate prefers the notary route/);
  assert.equal(statSync(join(h, "out", "answers.md")).mode & 0o777, 0o600);
  assert.equal(readFileSync(marker, "utf8"), "J-1", "onComplete runs as an argv, with its own arguments");
  assert.equal(JSON.parse(readFileSync(join(h, "asks", "pub.json"), "utf8")).status, "done");
  await assert.rejects(run(tools, "ask_answer", { ask: "pub", question: 1, answer: "x", answered_by: "Kate" }), /not open/);
  assert.equal(await run(tools, "ask_open", {}), "No open asks.");
});

test("a failing onComplete names its cause and leaves the ask open to retry", async (t) => {
  const h = home(t);
  write(h, { questions: [{ n: 1, text: "ok?" }], onComplete: ["/bin/sh", "-c", "echo 'job J-1 is already done' >&2; exit 1"] });
  const asks = new Asks(h);
  asks.record("pub", 1, "yes", "Kate");
  await assert.rejects(asks.finish("pub"), /onComplete failed .*job J-1 is already done/);
  assert.equal(asks.load("pub").status, "open");
});

test("bad asks and bad input are refused with their cause", async (t) => {
  const h = home(t);
  const asks = new Asks(h);
  assert.throws(() => asks.load("../x"), /must be letters/);
  assert.throws(() => asks.load("missing"), /no ask "missing"/);
  write(h, { answersFile: "relative.md" });
  assert.throws(() => asks.load("pub"), /answersFile must be an absolute path/);
  write(h);
  assert.throws(() => asks.record("pub", 9, "a", "Kate"), /no question 9/);
  assert.throws(() => asks.record("pub", 1, " ", "Kate"), /answer is empty/);
  assert.equal(existsSync(join(h, "out")), false);
  assert.match(Asks.message(asks.load("pub")), /1\. Fee\?\n2\. Notary first\?[\s\S]*Kate, reply to this message/);
});

test("waitingOn matches the askee to a member's configured name, only for open asks in that chat", (t) => {
  const h = home(t);
  write(h);
  const asks = new Asks(h);
  assert.equal(asks.waitingOn(-5269168638, "Kate"), true);
  assert.equal(asks.waitingOn(-5269168638, "Kate (attorney)"), true);
  assert.equal(asks.waitingOn(-5269168638, "Nico"), false);
  assert.equal(asks.waitingOn(-1, "Kate"), false);
  write(h, { status: "done" });
  assert.equal(asks.waitingOn(-5269168638, "Kate"), false);
});
