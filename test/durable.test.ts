// The durable parts: the delivery ledger, the interrupted-turn inspection and the honest tool result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryLedger, deliveryId, inspectTurn, interruptedToolResult, isInterruptedResult, INTERRUPTED_TOOL_RESULT } from "../src/durable.ts";

const home = () => mkdtempSync(join(tmpdir(), "carl-durable-"));

test("a reply is sent once: the ledger remembers what went out, even across a restart", () => {
  const h = home();
  const ledger = new DeliveryLedger(h);
  const id = deliveryId("telegram:dm:4242", 20);
  assert.equal(ledger.begin(id), "new", "a reply that never went out may be sent");
  assert.equal(ledger.get(id)?.phase, "sending");
  ledger.sent(id, [1001]);
  // A restart reads the same file: the reply is known to be delivered.
  const afterRestart = new DeliveryLedger(h);
  assert.equal(afterRestart.begin(id), "sent", "a delivered reply is not sent again");
  assert.deepEqual(afterRestart.get(id)?.messageIds, [1001]);
  rmSync(h, { recursive: true, force: true });
});

test("a send that was never confirmed is not repeated either", () => {
  const h = home();
  const ledger = new DeliveryLedger(h);
  const id = deliveryId("telegram:dm:4242", 21);
  assert.equal(ledger.begin(id), "new");
  // The process died between the send and the record: the reply may or may not have gone out.
  assert.equal(new DeliveryLedger(h).begin(id), "unconfirmed", "an unconfirmed reply is not sent again");
  // A send that failed outright may be tried again.
  ledger.drop(id);
  assert.equal(ledger.begin(id), "new");
  rmSync(h, { recursive: true, force: true });
});

test("a settled card may be asked about again, an open one may not", () => {
  const h = home();
  const ledger = new DeliveryLedger(h);
  const id = "approval:telegram:dm:4242#1#abc";
  assert.equal(ledger.begin(id), "new");
  ledger.sent(id, [7]);
  assert.equal(ledger.begin(id), "sent", "the card is already in the chat: no second one");
  ledger.resolve(id);
  assert.equal(ledger.begin(id), "new", "the operator answered it: a later proposal may ask again");
  rmSync(h, { recursive: true, force: true });
});

test("the ledger keeps only recent deliveries", () => {
  const h = home();
  const ledger = new DeliveryLedger(h);
  ledger.begin("old", { preview: "x" });
  const file = join(h, "state", "deliveries.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.old.at = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
  writeFileSync(file, JSON.stringify(raw));
  const fresh = new DeliveryLedger(h);
  fresh.begin("new");
  const kept = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(!("old" in kept), "an old delivery is forgotten");
  assert.ok("new" in kept);
  rmSync(h, { recursive: true, force: true });
});

test("the ledger keeps the newest deliveries, not the oldest", () => {
  const h = home();
  const ledger = new DeliveryLedger(h);
  // More records than the ledger holds: the newest ones are the ones that matter.
  for (let i = 0; i < 520; i++) ledger.begin(`id-${i}`, { preview: `reply ${i}` });
  const kept = JSON.parse(readFileSync(join(h, "state", "deliveries.json"), "utf8"));
  const ids = Object.keys(kept);
  assert.ok(ids.length <= 500, "the ledger stays small");
  assert.ok("id-519" in kept, "the newest delivery is kept");
  assert.ok(!("id-0" in kept), "the oldest delivery is the one that is forgotten");
  assert.equal(ledger.get("id-519")?.phase, "sending", "the newest delivery is still known");
  rmSync(h, { recursive: true, force: true });
});

test("the delivery id does not depend on the turn: a compaction cannot change it", () => {
  assert.equal(deliveryId("telegram:dm:4242", 20), "telegram:dm:4242#20#answer");
  assert.equal(deliveryId("telegram:dm:4242", 20, "notice"), "telegram:dm:4242#20#notice");
  assert.notEqual(deliveryId("telegram:dm:4242", 20, "notice"), deliveryId("telegram:dm:4242", 20), "each part has its own id");
});

test("the ledger never keeps the text of a reply, only its size and a hash", () => {
  const h = home();
  const ledger = new DeliveryLedger(h);
  ledger.begin("secret", { preview: "the operator's private answer" });
  const raw = readFileSync(join(h, "state", "deliveries.json"), "utf8");
  assert.ok(!raw.includes("private answer"), "the text is not in the ledger");
  const rec = ledger.get("secret")!;
  assert.equal(rec.preview?.len, "the operator's private answer".length);
  assert.match(String(rec.preview?.hash), /^[0-9a-f]{16}$/);
  rmSync(h, { recursive: true, force: true });
});

test("a corrupt ledger fails closed and is kept for inspection", () => {
  const h = home();
  mkdirSync(join(h, "state"), { recursive: true });
  writeFileSync(join(h, "state", "deliveries.json"), "{not json");
  const ledger = new DeliveryLedger(h);
  assert.equal(ledger.begin("anything"), "unconfirmed", "a reply that may have gone out is not sent again");
  assert.equal(readFileSync(join(h, "state", "deliveries.json"), "utf8"), "{not json", "the ledger itself is not overwritten");
  assert.ok(readdirSync(join(h, "state")).some((f) => f.includes("corrupt")), "the unreadable ledger is kept for inspection");
  rmSync(h, { recursive: true, force: true });
});

test("the transcript says what an interrupted turn achieved", () => {
  const user = { role: "user", content: [{ type: "text", text: "deploy the site now" }] };
  const call = { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] };
  const result = { role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "done" }] };
  const answer = { role: "assistant", content: [{ type: "text", text: "the deploy finished" }] };

  const nothing = inspectTurn([user], "deploy the site now");
  assert.equal(nothing?.state, "nothing", "a turn that never ran can be run again");
  assert.equal(nothing?.turn, 1);

  const waiting = inspectTurn([user, call], "deploy the site now");
  assert.equal(waiting?.state, "waiting", "a turn with a tool call owes an answer");
  assert.equal(waiting?.pending.length, 1, "the tool call has no result: its effect is unknown");
  assert.equal(waiting?.calls[0].name, "bash");

  const answered = inspectTurn([user, call, result, answer], "deploy the site now");
  assert.equal(answered?.state, "answered");
  assert.equal(answered?.finalText, "the deploy finished");
  assert.equal(answered?.pending.length, 0, "every tool call has a result");

  assert.equal(inspectTurn([user], "something else"), undefined, "a message that is not in the transcript is not resumed");
});

test("the transcript matches the operator's words exactly, and the turn ends at the next one", () => {
  const user = { role: "user", content: [{ type: "text", text: "deploy the site now" }] };
  const call = { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] };
  const next = { role: "user", content: [{ type: "text", text: "and now the other one" }] };
  const laterCall = { role: "assistant", content: [{ type: "toolCall", id: "2", name: "write", arguments: {} }] };
  assert.equal(inspectTurn([user], "deploy the site now please"), undefined, "different words are a different message");
  assert.equal(inspectTurn([user], " deploy the site now ")?.state, "nothing", "the text is trimmed before it is compared");
  const turn = inspectTurn([user, call, next, laterCall], "deploy the site now");
  assert.equal(turn?.calls.length, 1, "the next turn's tool call is not this turn's work");
  assert.equal(turn?.calls[0].name, "bash");
});

test("a tool call without a result gets an honest result, not a fake failure", () => {
  const message = interruptedToolResult({ id: "1", name: "bash" });
  assert.equal(message.role, "toolResult");
  assert.equal(message.toolCallId, "1");
  assert.equal(message.toolName, "bash");
  assert.equal(message.content[0].text, INTERRUPTED_TOOL_RESULT);
  assert.match(message.content[0].text, /interrupted by a restart/);
  assert.match(message.content[0].text, /may or may not have taken effect/);
  assert.match(message.content[0].text, /do not repeat it without checking/);
  assert.notEqual(message.content[0].text, "No result provided", "the model is not told a lie");
});

test("the interrupted result carries a structured mark, not only a phrase", () => {
  const message = interruptedToolResult({ id: "1", name: "bash" });
  assert.equal(message.details?.interruptedByRestart, true, "the mark is a field on the result");
  assert.equal(isInterruptedResult(message), true);
  assert.equal(isInterruptedResult({ role: "toolResult", content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }] }), false,
    "a phrase in the text is not the mark");
});

test("a verbatim resend is refused only after a tool call a restart cut short", async () => {
  const h = home();
  const user = { role: "user", content: [{ type: "text", text: "restart the scraper" }], timestamp: 1 };
  const call = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], timestamp: 2 };
  const answer = { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: Date.now() };
  const finished = [user, call, { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }, answer];
  const cut = [user, call, interruptedToolResult({ id: "c1", name: "bash" }), answer];
  const { Brain } = await import("../src/brain.ts");
  const probe = (messages: any[]) => (Brain.prototype as any).recentDuplicate.call(
    { cfg: { home: h }, get: async () => ({ session: { messages } }) }, "telegram:dm:1", "restart the scraper");
  assert.equal(await probe(finished), undefined, "a request that finished normally can be repeated on purpose");
  assert.equal((await probe(cut))?.text, "Done.", "a resend after an interrupted tool call is answered, not run again");
  rmSync(h, { recursive: true, force: true });
});

/** A session whose context was compacted: the raw transcript still holds the message and its tool call. */
function compactedSession(home: string, text: string): void {
  const dir = join(home, "sessions", "telegram_dm_4242");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-10-15T00-00-00-000Z_x.jsonl"), [
    { type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } },
    { type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "npm run deploy" } }], timestamp: Date.now() } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("a message that left the context is reported, not run again", async () => {
  const { Brain } = await import("../src/brain.ts");
  const h = home();
  compactedSession(h, "deploy the site now");
  // The context of the live session holds a summary, not the message: a compaction summarised it away.
  const outcome = await (Brain.prototype as any).resumeTurn.call({
    cfg: { home: h },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    get: async () => ({ session: { messages: [{ role: "user", content: [{ type: "text", text: "a summary of earlier turns" }] }] } }),
    nextTurn: () => 2,
    run: async () => { throw new Error("the turn must not be run again"); },
  }, "telegram:dm:4242", "deploy the site now", {});
  assert.notEqual(outcome.status, "restart", "the turn is not run again: a tool ran after it");
  assert.equal(outcome.status, "not-resumable");
  rmSync(h, { recursive: true, force: true });
});

test("a verbatim resend of a message that left the context is answered, not run again", async () => {
  const { Brain } = await import("../src/brain.ts");
  const h = home();
  compactedSession(h, "deploy the site now");
  const done = await (Brain.prototype as any).recentDuplicate.call({
    cfg: { home: h },
    get: async () => ({ session: { messages: [] } }),
  }, "telegram:dm:4242", "deploy the site now");
  assert.ok(done, "the resend is refused: the tool call may already have taken effect");
  assert.match(done.text, /may already have taken effect/);
  rmSync(h, { recursive: true, force: true });
});
