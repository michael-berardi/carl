// Update contract v1: the cached anonymous check, the terminal notice and when it stays quiet, skip/auto persistence,
// `carl update` prompts and exit codes, verified installs, the gateway notice, the web app's controls and the debris bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoLog, availableUpdate, cacheDir, checkRelease, cleanupPrevious, commandNotice, detectInstall, install, isNewer, noticesEnabled, noticeText, readAutoConfig, readCheckCache, readState, setUpdateConfig, updateCommand, UpdatePlugin, writeState, type UpdateControls } from "../src/update.ts";
import { VERSION } from "../src/version.ts";
import { mountPortal } from "../src/portal/api.ts";
import type { Gateway } from "../src/gateway.ts";

const DAY_MS = 24 * 3600_000;
const LATEST = "9.9.9";
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `carl-contract-${name}-`));

/** A fake GitHub on 127.0.0.1 plus a private cache dir and CARL_HOME for the duration of `run`. No test touches the network. */
async function fakeGitHub(handler: (url: string, res: any, req: any) => void, run: (o: { base: string; hits: string[]; home: string; cache: string }) => Promise<void>) {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(req.url ?? ""); handler(req.url ?? "", res, req); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const home = tmp("home");
  const cache = tmp("cache");
  const vars: Record<string, string> = { CARL_UPDATE_API: base, CARL_UPDATE_DOWNLOAD: base, CARL_UPDATE_CACHE_DIR: cache, CARL_HOME: home };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { await run({ base, hits, home, cache }); }
  finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
}

const release = (tag: string, body = "- a note") => JSON.stringify({ tag_name: tag, body, html_url: `https://example.test/releases/${tag}` });
const latestOnly = (tag = `v${LATEST}`) => (url: string, res: any) => url.endsWith("/releases/latest") ? res.end(release(tag)) : (res.statusCode = 404, res.end("{}"));
const quietIO = (lines: string[] = []) => ({ interactive: false, out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) });
const cfgOf = (home: string, auto = false) => () => ({ home, update: { check: true, auto } });

test("version comparison: newer, equal, older, garbage and prereleases", () => {
  assert.ok(isNewer("v1.0.0", "0.99.99"));
  assert.ok(isNewer("0.19.1", "0.19.0"));
  assert.ok(isNewer("0.10.0", "0.9.3"), "numeric, not lexical");
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "1.0.1"), false);
  for (const bad of ["vault", "1.2", "1.2.3-beta.1", "1.2.3+meta", "", "NaN.NaN.NaN", "01.2.3x"]) assert.equal(isNewer(bad, "0.1.0"), false, `${bad} is never newer`);
  assert.equal(isNewer("1.0.0", "garbage"), false, "an unparseable current version never reports an update");
});

test("the check: one anonymous GET a day, cached privately; a failure is cached with its cause and not retried", async () => {
  let fail = true;
  await fakeGitHub((url, res, req) => {
    assert.equal(req.headers["user-agent"], "carl-update-check");
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(new URL(url, "http://x").search, "", "no query: no id, no version");
    if (fail) return (res.statusCode = 503, res.end("down"));
    res.end(release(`v${LATEST}`));
  }, async ({ hits }) => {
    await assert.rejects(checkRelease({ slug: "o/r" }), /GitHub answered 503/);
    assert.match(readCheckCache()?.error ?? "", /503/, "the cause is recorded");
    fail = false;
    await assert.rejects(checkRelease({ slug: "o/r" }), /last check failed: GitHub answered 503/);
    assert.equal(hits.length, 1, "a cached failure makes no second request");
    assert.equal((await checkRelease({ slug: "o/r", force: true })).version, LATEST, "an explicit check asks again");
    assert.equal(readCheckCache()?.error, undefined, "a success clears the old cause");
    await checkRelease({ slug: "o/r" });
    assert.equal(hits.length, 2, "a fresh cache answers without a request");
    const file = join(cacheDir(), "update-check.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    await checkRelease({ slug: "o/r", now: Date.now() + DAY_MS + 1 });
    assert.equal(hits.length, 3, "a day later the check runs again");
  });
});

test("the notice stays quiet without a TTY, in CI, in agent sessions and after an opt-out", () => {
  const cfg = { update: { check: true, auto: false } };
  assert.equal(noticesEnabled(cfg, {}, true), true);
  assert.equal(noticesEnabled(cfg, {}, false), false, "stdout or stderr not a TTY");
  for (const env of [{ CI: "1" }, { CI: "woodpecker" }, { CLAUDECODE: "1" }, { CODEX_SANDBOX: "seatbelt" }, { CARL_NO_UPDATE_CHECK: "1" }, { CARL_OFFLINE: "1" }])
    assert.equal(noticesEnabled(cfg, env, true), false, JSON.stringify(env));
  assert.equal(noticesEnabled(cfg, { CI: "false" }, true), true, "CI=false is not CI");
  assert.equal(noticesEnabled({ update: { check: false, auto: false } }, {}, true), false, "the carl.json switch");
});

test("notice text and placement: two lines after a command, once a day per version, never for --json, update or a skipped version", async () => {
  assert.equal(noticeText(LATEST), `carl ${LATEST} available (you have ${VERSION}) · run: carl update\nturn on automatic updates: carl update --auto on · skip: carl update --skip`);
  assert.equal(noticeText(LATEST, { auto: true }), `carl ${LATEST} available (you have ${VERSION}) · run: carl update`, "with auto on there is nothing to turn on");
  assert.match(noticeText(LATEST, { dim: true }).split("\n")[1], /^\x1b\[2m.*\x1b\[0m$/, "the second line is dim");
  let tag = `v${LATEST}`;
  await fakeGitHub((url, res) => url.endsWith("/releases/latest") ? res.end(release(tag)) : (res.statusCode = 404, res.end("{}")), async ({ home, hits }) => {
    const notice = (args: string[], env: NodeJS.ProcessEnv = {}, tty = true) => commandNotice(args, env, tty, cfgOf(home));
    assert.equal(await notice(["status", "--json"]), undefined, "never with JSON output");
    assert.equal(await notice(["update", "--check"]), undefined, "update reports for itself");
    assert.equal(await notice(["status"], {}, false), undefined, "no TTY");
    assert.equal(await notice(["status"], { CI: "1" }), undefined, "CI");
    assert.equal(hits.length, 0, "a quiet notice makes no request");
    assert.equal(await notice(["status"], { NO_COLOR: "1" }), noticeText(LATEST));
    assert.equal(await notice(["status"]), undefined, "already shown today");
    assert.equal(existsSync(join(home, "state")), false, "showing the notice writes nothing under CARL_HOME");
    writeState(home, { skipped: LATEST });
    const age = (patch: object) => {
      const file = join(cacheDir(), "update-check.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
    };
    age({ shownAt: Date.now() - DAY_MS - 1 });
    assert.equal(await notice(["status"]), undefined, "a skipped version stays quiet");
    tag = "v9.9.10";
    age({ checkedAt: Date.now() - DAY_MS - 1 });
    assert.match(await notice(["status"], {}, true) ?? "", /^carl 9\.9\.10 available/, "a newer release than the skipped one shows again");
    assert.equal(await commandNotice(["status"], { NO_COLOR: "1" }, true, cfgOf(home, true)), undefined, "once a day, also with auto on");
  });
});

test("--skip hides one version, --auto on|off|status persists in carl.json, and update --check exits 0/10/1 with the cause", async () => {
  let tag = `v${LATEST}`;
  let fail = false;
  await fakeGitHub((url, res) => {
    if (!url.endsWith("/releases/latest")) return (res.statusCode = 404, res.end("{}"));
    if (fail) return (res.statusCode = 500, res.end("server error"));
    res.end(release(tag));
  }, async ({ home }) => {
    const file = join(home, "carl.json");
    const original = { name: "Gateway", telegram: { homeChat: 7, allowFrom: [7] }, update: { check: true }, extras: [1, 2, 3] };
    writeFileSync(file, JSON.stringify(original, null, 2));
    const lines: string[] = [];
    const io = quietIO(lines);
    assert.equal(await updateCommand(["--check"], io), 10);
    assert.match(lines.join("\n"), new RegExp(`Carl ${VERSION} → ${LATEST}\\n- a note\\nhttps://example.test/releases/v${LATEST}`));
    assert.equal(await updateCommand(["--skip"], io), 0);
    assert.equal(readState(home).skipped, LATEST);
    writeState(home, { latest: LATEST });
    assert.equal(availableUpdate(home), undefined, "a skipped version is not offered");
    writeState(home, { latest: "9.9.10" });
    assert.equal(availableUpdate(home), "9.9.10", "a newer one is");

    assert.equal(readAutoConfig(home), false, "auto is off by default");
    assert.equal(await updateCommand(["--auto", "on"], io), 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...original, update: { check: true, auto: true } }, "every other setting survives");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(home).filter((n) => n.startsWith("carl.json")), ["carl.json"], "no temp file is left");
    lines.length = 0;
    assert.equal(await updateCommand(["--auto", "status"], io), 0);
    assert.deepEqual(lines, ["automatic updates: on"]);
    assert.equal(await updateCommand(["--auto", "maybe"], io), 64);

    lines.length = 0;
    tag = `v${VERSION}`;
    assert.equal(await updateCommand(["--check", "--refresh"], io), 0);
    assert.deepEqual(lines, [`Carl ${VERSION} is up to date.`]);
    fail = true;
    lines.length = 0;
    assert.equal(await updateCommand(["--check", "--refresh"], io), 1);
    assert.match(lines[0], /^carl update: GitHub answered 500/);
    assert.match(readState(home).error ?? "", /500/, "the cause is recorded");
    lines.length = 0;
    assert.equal(await updateCommand(["--check"], io), 1, "a cached failure is reported, not retried");
    assert.match(lines[0], /^carl update: last check failed: GitHub answered 500/);
    assert.deepEqual(lines.slice(1), ["Check again now: carl update --check --refresh"]);
  });
});

test("carl update: [Y/n] on a TTY, then the one-time [y/N] auto question; no is remembered; without a TTY no questions", async () => {
  await fakeGitHub(latestOnly(), async ({ home }) => {
    writeFileSync(join(home, "carl.json"), JSON.stringify({ update: { check: true, auto: false } }));
    const questions: string[] = [];
    let installs = 0;
    const answers: boolean[] = [];
    const io = {
      interactive: true,
      ask: async (q: string) => { questions.push(q); return answers.shift() ?? false; },
      installer: async () => { installs++; return { from: VERSION, to: LATEST, path: "/fake/release" }; },
      out: () => {}, err: (s: string) => { throw new Error(s); },
    };
    answers.push(false);
    assert.equal(await updateCommand([], io), 0);
    assert.deepEqual(questions, [`Install ${LATEST} now? [Y/n] `]);
    assert.equal(installs, 0, "no means nothing is installed");

    questions.length = 0;
    answers.push(true, false);
    assert.equal(await updateCommand([], io), 0);
    assert.deepEqual(questions, [`Install ${LATEST} now? [Y/n] `, "Install future updates automatically? [y/N] "]);
    assert.equal(installs, 1);
    assert.equal(readState(home).autoOfferDeclined, true);
    assert.equal(readAutoConfig(home), false);

    questions.length = 0;
    answers.push(true);
    await updateCommand([], io);
    assert.deepEqual(questions, [`Install ${LATEST} now? [Y/n] `], "the auto question is never asked again after no");

    questions.length = 0;
    await updateCommand([], { ...io, interactive: false });
    assert.deepEqual(questions, [], "an explicit non-TTY update installs without questions");
    assert.equal(installs, 3);

    writeState(home, { autoOfferDeclined: undefined });
    answers.push(true, true);
    await updateCommand([], io);
    assert.equal(readAutoConfig(home), true, "yes turns automatic updates on");
  });
});

/** A release bundle laid out like scripts/build-release.sh: files at the root, bin/carl prints the version, no dependencies. */
function bundle(version: string): Buffer {
  const src = tmp("src");
  try {
    mkdirSync(join(src, "bin"));
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "carl-gateway", version }));
    writeFileSync(join(src, "package-lock.json"), JSON.stringify({ name: "carl-gateway", version, lockfileVersion: 3, requires: true, packages: { "": { name: "carl-gateway", version } } }));
    writeFileSync(join(src, "bin", "carl"), `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(src, "bin", "carl"), 0o755);
    return spawnSync("tar", ["-czf", "-", "-C", src, "package.json", "package-lock.json", "bin"]).stdout;
  } finally { rmSync(src, { recursive: true, force: true }); }
}

test("install safety: a checksum mismatch or missing SHA256SUMS refuses before anything is switched, and temp folders never stay", async () => {
  const sha = "d".repeat(40);
  const tgz = bundle(LATEST);
  let sums: string | undefined = `${"0".repeat(64)}  carl.tar.gz\n`;
  await fakeGitHub((url, res) => {
    if (url === "/repos/o/r/commits/v9.9.9") return res.end(sha);
    if (url === "/o/r/releases/download/v9.9.9/SHA256SUMS" && sums !== undefined) return res.end(sums);
    if (url === "/o/r/releases/download/v9.9.9/carl.tar.gz") return res.end(tgz);
    res.statusCode = 404; res.end("{}");
  }, async () => {
    const app = realpathSync(tmp("app"));
    try {
      const old = join(app, "release-0.9.0-000000000000");
      mkdirSync(old);
      symlinkSync(old, join(app, "current"));
      const inst = detectInstall(old, join(app, "current", "bin", "carl"));
      const rel = { tag: `v${LATEST}`, version: LATEST, notes: "", url: "" };
      const untouched = () => {
        assert.equal(readlinkSync(join(app, "current")), old);
        assert.deepEqual(readdirSync(app).sort(), ["current", "release-0.9.0-000000000000"], "no download folder, no new release");
      };
      await assert.rejects(install(rel, inst, "o/r"), /checksum mismatch for carl\.tar\.gz of v9\.9\.9; nothing was switched/);
      untouched();
      sums = undefined;
      await assert.rejects(install(rel, inst, "o/r"), /cannot download SHA256SUMS of v9\.9\.9 \(HTTP 404\); nothing was switched/, "no unverified fallback");
      untouched();
      sums = "garbage\n";
      await assert.rejects(install(rel, inst, "o/r"), /has no carl\.tar\.gz entry/);
      untouched();
      sums = `${createHash("sha256").update(tgz).digest("hex")}  carl.tar.gz\n`;
      const done = await install(rel, inst, "o/r");
      assert.equal(done.to, LATEST);
      assert.equal(readlinkSync(join(app, "current")), join(app, `release-${LATEST}-${sha.slice(0, 12)}`));
      assert.equal(readlinkSync(join(app, "current.previous")), old);
      assert.deepEqual(readdirSync(app).filter((n) => n.startsWith(".incoming-")), [], "the download folder is gone after success");
    } finally { rmSync(app, { recursive: true, force: true }); }
  });
});

test("no debris: the rollback copy goes after one run of the new version or seven days, one at most, and a shared folder stays", () => {
  const app = realpathSync(tmp("app"));
  const home = tmp("home");
  try {
    const old = join(app, "release-0.9.0-000000000000");
    const current = join(app, `release-${VERSION}-111111111111`);
    mkdirSync(old); mkdirSync(current);
    symlinkSync(current, join(app, "current"));
    symlinkSync(old, join(app, "current.previous"));
    symlinkSync(old, join(app, "second"));
    const inst = detectInstall(current, join(app, "current", "bin", "carl"));
    const now = Date.now();
    writeState(home, { previousAt: now });
    assert.deepEqual(cleanupPrevious(home, inst, now), [], "a fresh rollback copy stays");
    assert.deepEqual(cleanupPrevious(home, inst, now + 6 * DAY_MS), []);
    assert.ok(existsSync(join(app, "current.previous")));
    assert.deepEqual(cleanupPrevious(home, inst, now + 8 * DAY_MS), [], "after seven days the link goes; the folder another bot links stays");
    assert.equal(existsSync(join(app, "current.previous")), false);
    assert.ok(existsSync(old));
    assert.equal(readState(home).previousAt, undefined);

    symlinkSync(old, join(app, "current.previous"));
    rmSync(join(app, "second"));
    writeState(home, { installed: { from: "0.9.0", to: VERSION, at: now } });
    assert.deepEqual(cleanupPrevious(home, inst, now), ["release-0.9.0-000000000000"], "one run of the new version retires it");
    assert.deepEqual(readdirSync(app).sort(), ["current", `release-${VERSION}-111111111111`]);

    symlinkSync(join(app, "release-0.8.0-222222222222"), join(app, "current.previous"));
    assert.deepEqual(cleanupPrevious(home, inst, now), [], "a dangling rollback link does not throw");
    assert.equal(existsSync(join(app, "current.previous")) || readdirSync(app).includes("current.previous"), false, "and is removed");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(app, { recursive: true, force: true });
  }
});

test("no debris: the check writes one tiny file, the install log stays one file under 256 KB, and --auto off removes the cache", async () => {
  await fakeGitHub(latestOnly(), async ({ home, cache }) => {
    await checkRelease({ slug: "o/r" });
    await commandNotice(["status"], {}, true, cfgOf(home));
    assert.deepEqual(readdirSync(cache), ["update-check.json"], "one file, no temp files");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cache, "update-check.json"), "utf8"))).sort(), ["checkedAt", "notes", "shown", "shownAt", "version"]);
    assert.ok(statSync(join(cache, "update-check.json")).size < 1_024);
    assert.equal(existsSync(home) && readdirSync(home).length, 0, "nothing under CARL_HOME");

    for (let i = 0; i < 400; i++) autoLog(home, "info", "install cycle", { n: i, text: "é".repeat(i === 7 ? 50_000 : 600) });
    const log = join(home, "logs", "auto-update.log");
    assert.ok(statSync(log).size <= 256 * 1024, `log is ${statSync(log).size} bytes`);
    assert.deepEqual(readdirSync(join(home, "logs")), ["auto-update.log"], "one file, no rotations left");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.doesNotThrow(() => lines.forEach((l) => JSON.parse(l)), "only whole lines are kept");
    assert.equal(JSON.parse(lines.at(-1)!).n, 399, "the newest line is kept");

    assert.equal(await updateCommand(["--auto", "off"], quietIO()), 0);
    assert.deepEqual(readdirSync(cache), [], "auto off removes the one update file outside CARL_HOME");
    assert.equal(readAutoConfig(home), false);
    assert.equal(readState(home).autoOfferDeclined, true, "an explicit off is not asked about again");
  });
});

/** A gateway with a Telegram channel that records what it sends. */
function fakeGateway(home: string, auto = false) {
  const sent: { chat: number; text: string; buttons?: any[][] }[] = [];
  const callbacks = new Map<string, (q: any, data: string) => Promise<string | void>>();
  const tg = {
    commands: new Map<string, any>(), callbacks,
    api: { call: async () => true },
    sendMarkdown: async (chat: number, text: string, o: any = {}) => { sent.push({ chat, text, buttons: o.buttons }); return []; },
  };
  const gw = {
    cfg: { home, update: { check: true, auto }, telegram: { homeChat: 42 } },
    brain: { busyCount: () => 0 }, scheduler: { runningCount: () => 0 },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    telegram: tg,
    send: async (_t: string, text: string) => { sent.push({ chat: 42, text }); },
  } as unknown as Gateway;
  const timers: number[] = [];
  const clock = { now: () => Date.now(), after: (_f: () => void, ms: number) => { timers.push(ms); return { unref() {} } as NodeJS.Timeout; } };
  return { gw, sent, callbacks, tg, timers, plugin: new UpdatePlugin(clock) };
}

test("the gateway's home-chat notice: notes plus Update now / Skip / Turn on automatic updates, once a day, and a skip holds", async () => {
  await fakeGitHub(latestOnly(), async ({ home }) => {
    const { gw, sent, callbacks, tg, timers, plugin } = fakeGateway(home);
    plugin.start(gw);
    assert.equal(timers.length, 1, "the check is scheduled, not run on start");
    await (plugin as any).tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, `Carl ${LATEST} is available — you have ${VERSION}.\n\n- a note`);
    assert.deepEqual(sent[0].buttons!.flat().map((b) => b.text), ["Update now", "Skip this version", "Turn on automatic updates"]);
    await (plugin as any).tick();
    assert.equal(sent.length, 1, "once a day per version");
    assert.ok(tg.commands.has("update"), "/update is the command fallback");
    const q = { id: "1", from: { id: 42 }, message: { chat: { id: 42 }, message_id: 7 } };
    assert.equal(await callbacks.get("upd")!(q, `upd:skip:${LATEST}`), `Skipped Carl ${LATEST}. A newer release will show again.`);
    writeState(home, { notifiedAt: 0 });
    await (plugin as any).tick();
    assert.equal(sent.length, 1, "a skipped version is not announced");
    assert.equal(await callbacks.get("upd")!(q, `upd:auto:${LATEST}`), "Automatic updates are on.");
    assert.equal(readAutoConfig(home), true);
    assert.equal(gw.cfg.update.auto, true);

    (gw.updates as UpdateControls).setCheck(false);
    assert.equal(JSON.parse(readFileSync(join(home, "carl.json"), "utf8")).update.check, false);
    timers.length = 0;
    (gw.updates as UpdateControls).setCheck(true);
    assert.deepEqual(timers, [60_000], "turning checks on arms the daily check again");
    plugin.stop();
  });
});

test("a failed automatic install keeps the current version, records the cause, and falls back to the notice", async () => {
  await fakeGitHub(latestOnly(), async ({ home }) => {
    const { gw, sent, plugin } = fakeGateway(home, true);
    plugin.start(gw);
    const prev = process.env.CARL_ENTRY;
    process.env.CARL_ENTRY = join(home, "missing-launcher");
    try { await (plugin as any).tick(); } finally { if (prev === undefined) delete process.env.CARL_ENTRY; else process.env.CARL_ENTRY = prev; }
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, new RegExp(`^Update to ${LATEST} failed: .+\\nCarl keeps running ${VERSION.replace(/\./g, "\\.")}\\.\\n\\nCarl ${LATEST} is available`));
    assert.match(readState(home).error ?? "", /.+/, "the cause is recorded");
    assert.match(readFileSync(join(home, "logs", "auto-update.log"), "utf8"), /"install failed"/);
    plugin.stop();
  });
});

test("the web app: banner and Updates rows per the layout, status fields, and the actions behind them", async () => {
  const html = readFileSync(new URL("../src/portal/static/index.html", import.meta.url), "utf8");
  const section = html.slice(html.indexOf('<section class="updates"'), html.indexOf("</section>", html.indexOf('<section class="updates"')));
  assert.match(section, /Skip This Version<\/button>\s*<button[^>]*>Remind Me Later<\/button>\s*<button id="update-install">Install Update<\/button>/, "primary action trailing, on the text's row");
  assert.match(section, /<input type="checkbox" id="update-auto-next"> Automatically download and install updates in the future/);
  assert.doesNotMatch(section, /id="update-auto-next"[^>]*checked/, "the opt-in is unchecked");
  assert.match(section, /Check for updates automatically<input type="checkbox" class="switch" id="update-check-toggle" checked>/);
  assert.match(section, /Install updates automatically<input type="checkbox" class="switch" id="update-auto-toggle">/);
  assert.match(section, /<div class="update-row"><span id="update-version"><\/span><button id="update-check-now" class="quiet">Check Now<\/button><\/div>/, "version left, Check Now right, one row");

  await fakeGitHub(latestOnly(), async ({ home }) => {
    await checkRelease({ slug: "o/r" });
    writeState(home, { latest: LATEST });
    const calls: string[] = [];
    const controls: UpdateControls = {
      check: async () => { calls.push("check"); throw new Error("offline"); },
      install: async () => { calls.push("install"); return "installed"; },
      skip: () => (calls.push("skip"), "Skipped"),
      setAuto: (on) => (calls.push(`auto ${on}`), `Automatic updates are ${on ? "on" : "off"}.`),
      setCheck: (on) => (calls.push(`checks ${on}`), `Update checks are ${on ? "on" : "off"}.`),
    };
    const routes = new Map<string, any>();
    const api = { route: (method: string, pattern: RegExp, handler: any) => routes.set(`${method} ${pattern.source}`, handler) };
    const gw = {
      cfg: { home, model: "", fallbackModels: [], update: { check: true, auto: false } },
      health: () => ({ version: VERSION }),
      brain: { routerState: new Map(), activeConversations: () => [] }, scheduler: { list: () => [] }, psyche: { read: () => "" },
      log: { info: () => {}, warn: () => {} }, updates: controls,
    } as unknown as Gateway;
    mountPortal(api as any, gw);
    const call = async (key: string, body?: any) => {
      const res: any = { status: 0, body: "", writeHead(s: number) { this.status = s; }, end(s: string) { this.body = s; } };
      await routes.get(key)({}, res, new URL("http://x/"), body);
      return { status: res.status, body: JSON.parse(res.body) };
    };
    const status = (await call("GET ^\\/carl\\/status$")).body;
    assert.deepEqual([status.updateAvailable, status.updateNotes, status.updateCheck, status.updateAuto], [LATEST, "- a note", true, false]);
    const post = (body: any) => call("POST ^\\/carl\\/update$", body);
    assert.deepEqual(await post({ action: "check" }), { status: 200, body: { message: "Check failed: offline" } });
    assert.equal((await post({ action: "install" })).status, 202);
    assert.equal((await post({ action: "skip" })).body.message, "Skipped");
    assert.equal((await post({ action: "auto", on: true })).body.message, "Automatic updates are on.");
    assert.equal((await post({ action: "checks", on: false })).body.message, "Update checks are off.");
    assert.equal((await post({ action: "auto" })).status, 400, "auto needs a boolean");
    assert.deepEqual(calls, ["check", "install", "skip", "auto true", "checks false"]);
  });
});
