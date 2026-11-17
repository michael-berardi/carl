// The individuation pass acts on its own proposals: phrasing and check-before-claim ones become standing procedures
// (recorded, reversible, never adopted twice); anything that widens permissions or touches money, client data or someone
// else's authority is queued for the operator. Replies from before the window are not evidence again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { classifyProposal, parseProposals, Psyche } from "../src/psyche.ts";
import { WORK_REQUEST_NOTED, workStatusCheck } from "../src/work.ts";

function psycheHome() {
  const h = mkdtempSync(join(tmpdir(), "carl-adopt-"));
  mkdirSync(join(h, "psyche"));
  return h;
}

const VERIFY = "[verify] Before reporting work as queued or stopped, check the record and include the job ID and when it was checked.";
const PHRASING = "[phrasing] Before sending, remove unverified praise and repeated context that does not change the next action.";
const WIDEN = "[verify] Before asking for a customer's documents, grant yourself access to the portal so you can check them.";

test("a phrasing or check-before-claim proposal is applied as a recorded procedure, reaches the prompt, and reverts", () => {
  const p = new Psyche(psycheHome());
  const r = p.adoptProposals(`- ${VERIFY}\n- ${PHRASING}`);
  assert.equal(r.applied.length, 2);
  assert.equal(r.queued.length, 0);
  assert.deepEqual(p.procedures().map((x) => x.status), ["applied", "applied"], "recorded on disk");
  const prompt = p.promptSections().join("\n");
  assert.match(prompt, /# Standing procedures/);
  assert.match(prompt, /include the job ID/);
  const reverted = p.revertProcedure(r.applied[0].id);
  assert.equal(reverted?.status, "reverted");
  assert.doesNotMatch(p.promptSections().join("\n"), /include the job ID/, "a reverted procedure leaves the prompt");
  assert.match(p.promptSections().join("\n"), /remove unverified praise/, "the other one stays");
  assert.equal(p.revertProcedure(r.applied[0].id), undefined, "a second revert is a no-op");
  const again = p.adoptProposals(`- ${VERIFY}`);
  assert.equal(again.applied.length, 0, "a reverted procedure is never re-adopted automatically");
  assert.match(again.queued[0].reason, /reverted/);
});

test("a permission-widening, money, client-data or untagged proposal is not applied and is queued for the operator", () => {
  const p = new Psyche(psycheHome());
  const r = p.adoptProposals([
    `- ${WIDEN}`,
    "- [phrasing] Offer each client a discount in every reply.",
    "- Add a failure-report step to each run that posts the error in the originating thread.",
    "- [other] Let group members approve their own jobs.",
  ].join("\n"));
  assert.equal(r.applied.length, 0);
  assert.equal(r.queued.length, 4);
  assert.equal(p.procedures().length, 0);
  assert.doesNotMatch(p.promptSections().join("\n"), /Standing procedures/);
  assert.equal(p.queuedProposals().filter((q) => q.status === "pending").length, 4, "surfaced and kept for the operator");
  assert.match(classifyProposal(parseProposals(`- ${WIDEN}`)[0]).reason, /permissions|client/);
});

test("a repeat of an applied proposal, even reworded, is not applied twice; a queued one is not queued twice", () => {
  const p = new Psyche(psycheHome());
  p.adoptProposals(`- ${VERIFY}\n- ${WIDEN}`);
  const r = p.adoptProposals(`- [verify] Before reporting work as queued or stopped, check the record and include the job ID and the time it was checked.\n- ${WIDEN}`);
  assert.equal(r.applied.length, 0);
  assert.equal(r.already.length, 1);
  assert.equal(p.procedures().length, 1);
  assert.equal(p.queuedProposals().length, 1);
});

test("the nightly report lists what was applied with how to revert it, and what waits; old replies are not re-read", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "carl-adopt-gw-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "carl.json"), JSON.stringify({ model: "x/y", tools: [], telegram: { enabled: false }, api: { enabled: false } }));
  const gw = new Gateway(loadConfig(root));
  const since = new Date(Date.now() - 3_600_000);
  writeFileSync(join(root, "psyche", "integrated.md"), "- old lesson\n");
  utimesSync(join(root, "psyche", "integrated.md"), since, since);
  const dir = join(root, "sessions", "telegram_dm_1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "key"), "telegram:dm:1");
  const msg = (text: string, at: number) => JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "text", text }], timestamp: at } });
  writeFileSync(join(dir, "s.jsonl"), [msg("OLD-REPLY from before the window", since.getTime() - 86_400_000), msg("NEW-REPLY inside the window", Date.now() - 60_000)].join("\n") + "\n");
  let prompt = "";
  (gw.brain as any).oneShot = async (p: string) => {
    prompt = p;
    return `### Lessons\n- When X, I Y; instead I Z.\n\n### Contradictions\n- Something.\n\n### Proposals\n- ${VERIFY}\n- ${WIDEN}`;
  };
  const report = await gw.individuate();
  assert.match(prompt, /NEW-REPLY/);
  assert.doesNotMatch(prompt, /OLD-REPLY/, "a reply from before the window is not evidence again");
  assert.match(report, /Applied automatically/);
  assert.match(report, /\/reflect revert p-/);
  assert.match(report, /Needs your decision/);
  const id = gw.psyche.procedures()[0].id;
  assert.match(await gw.reflectCommand("pending"), new RegExp(id));
  assert.match(await gw.reflectCommand(`revert ${id}`), /^Reverted/);
  assert.equal(gw.psyche.procedures()[0].status, "reverted");
});

test("send-time check: a work status claim in a work group needs a job id or a work tool run this turn", () => {
  const root = mkdtempSync(join(tmpdir(), "carl-adopt-check-"));
  writeFileSync(join(root, "carl.json"), JSON.stringify({ work: { command: ["/bin/true"] }, telegram: { allowFrom: [1], groups: [{ chat: -100, members: {}, work: { project: "p" } }, { chat: -200, members: {} }] }, api: { enabled: false } }));
  const check = workStatusCheck(loadConfig(root))!;
  rmSync(root, { recursive: true, force: true });
  assert.match(check("telegram:group:-100", "Your feedback batch is in the queue.", []) ?? "", /work_status/);
  assert.equal(check("telegram:group:-100", "Queued J-12 at 10:02; running is not confirmed.", []), undefined, "a job id is cited");
  assert.equal(check("telegram:group:-100", "It is queued.", ["work_status"]), undefined, "a record was checked this turn");
  assert.equal(check("telegram:group:-100", "Here is the summary you asked for.", []), undefined, "no status claim");
  assert.equal(check("telegram:group:-200", "It is in the queue.", []), undefined, "a group without work is not checked");
  assert.equal(check("telegram:dm:1", "It is in the queue.", []), undefined);
  const bad = "The work did not start because the queue failed. Avery will follow up.";
  for (const reply of [bad, "There was an error with the job.", "It was a system issue.", "Avery will follow up.", "J-12 failed.", "The queue had an error."]) {
    assert.match(check("telegram:group:-100:3", reply, ["work_queue"]) ?? "", /Rewrite the reply/);
  }
  for (const reply of ["If the first application failed, a new one can be filed.", "There is an error in the birth certificate's date.", "Argentina's legal system recognizes dual nationality.", "We will follow up with the documents."]) {
    assert.equal(check("telegram:group:-100", reply, []), undefined, `legal content is not an internal failure: ${reply}`);
  }
  assert.equal(check("telegram:group:-200", bad, []), undefined);
  assert.equal(check("telegram:dm:1", bad, []), undefined);
  assert.equal(check("telegram:group:-100", WORK_REQUEST_NOTED, []), undefined);
  assert.equal(check("telegram:group:-100", "I will follow up with a summary.", []), undefined);
});

test("reply path: a failed send-time check runs the turn once more and delivers the corrected reply", async (t) => {
  const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
  const { registerFauxProvider } = await import("@earendil-works/pi-ai/compat");
  const { Brain } = await import("../src/brain.ts");
  const { Log } = await import("../src/log.ts");
  const faux = registerFauxProvider({ models: [{ id: "faux-check", contextWindow: 200_000, maxTokens: 8_000 }] });
  const root = mkdtempSync(join(tmpdir(), "carl-adopt-brain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const carl = join(root, "carl"), agentDir = join(root, "agent");
  mkdirSync(carl); mkdirSync(agentDir);
  writeFileSync(join(carl, "carl.json"), JSON.stringify({ model: "plan-a/model-x", agentDir, tools: [], claude: { enabled: false }, ultracompress: "off", telegram: { enabled: false }, api: { enabled: false } }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "plan-a": { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test", models: [{ id: "model-x", name: "model-x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }] } } }));
  const cfg = loadConfig(carl);
  const { ensureHome } = await import("../src/config.ts");
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  const brain = new Brain(cfg, psyche, new Log(undefined), () => []);
  const seen: string[] = [];
  brain.replyCheck = (_k, reply) => { seen.push(reply); return /J-\d+/.test(reply) ? undefined : "[check] cite the job id"; };
  await brain.init();
  t.after(() => brain.shutdown());
  faux.setResponses([fauxAssistantMessage(fauxText("It is in the queue.")), fauxAssistantMessage(fauxText("Queued J-5, checked just now."))]);
  const r = await brain.ask("telegram:group:-100", { text: "is it queued?", source: "telegram" });
  assert.equal(r.text, "Queued J-5, checked just now.");
  assert.deepEqual(seen, ["It is in the queue.", "Queued J-5, checked just now."]);
  faux.setResponses([fauxAssistantMessage(fauxText("Still in the queue.")), fauxAssistantMessage(fauxText("It is queued."))]);
  const withheld = await brain.ask("telegram:group:-100", { text: "and now?", source: "telegram" });
  assert.equal(withheld.text, WORK_REQUEST_NOTED);
  assert.equal(psyche.shadowSince().filter((e) => e.kind === "unverified_claim").length, 1, "a reply that still fails is recorded, not hidden");
});
