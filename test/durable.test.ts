// The durable parts: the delivery ledger, the interrupted-turn inspection and the honest tool result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryLedger, deliveryId, inspectTurn, interruptedToolResult, INTERRUPTED_TOOL_RESULT } from "../src/durable.ts";

const home = () => mkdtempSync(join(tmpdir(), "carl-durable-"));

test("a reply is sent once: the ledger remembers what went out, even across a restart", () => {
  const h = home();
  const ledger = new DeliveryLedger(h);
  const id = deliveryId("telegram:dm:4242", 20, 3);
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
  const id = deliveryId("telegram:dm:4242", 21, 1);
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
