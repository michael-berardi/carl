import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { setup } from "../src/setup.ts";
import { isAudio, parseTranscription, parseVersion, Ultravox, versionAtLeast, voiceNote } from "../src/ultravox.ts";

function homeWith(raw: object): string {
  const home = mkdtempSync(join(tmpdir(), "carl-uv-"));
  writeFileSync(join(home, "carl.json"), JSON.stringify(raw));
  return home;
}

test("ultravox is off by default and parses only when enabled", () => {
  const dirs: string[] = [];
  try {
    const mk = (raw: object) => { const h = homeWith(raw); dirs.push(h); return loadConfig(h); };
    assert.equal(mk({}).ultravox, undefined);
    assert.equal(mk({ ultravox: { enabled: false } }).ultravox, undefined);
    assert.deepEqual(mk({ ultravox: { enabled: true } }).ultravox, {});
    assert.deepEqual(mk({ ultravox: { enabled: true, model: "v3", app: "/opt/UltraVox.app", dictionary: "/tmp/words.txt" } }).ultravox, { model: "v3", app: "/opt/UltraVox.app", dictionary: "/tmp/words.txt" });
    assert.throws(() => mk({ ultravox: { enabled: true, model: "v9" } }), /ultravox.model must be/);
    assert.throws(() => mk({ ultravox: { enabled: "yes" } }), /ultravox.enabled must be true or false/);
    assert.throws(() => mk({ ultravox: { enabled: true }, stt: ["/bin/true"] }), /ultravox and stt are both set/);
    assert.equal(mk({ ultravox: { enabled: false }, stt: ["/bin/true"] }).stt?.[0], "/bin/true");
  } finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
});

test("output parser reads the transcription and names errors", () => {
  assert.equal(parseTranscription("transcribe: ok\n  path: a.ogg\n  version: v2\n  transcription: Hello there.\n"), "Hello there.");
  assert.equal(parseTranscription("transcribe: ok\n  transcription: first line\nsecond line\n  duration: 3\n"), "first line\nsecond line");
  assert.throws(() => parseTranscription("error: audio file not found: /x.ogg\n"), /audio file not found: \/x.ogg/);
  assert.throws(() => parseTranscription("transcribe: ok\n  transcription:   \n"), /no speech was recognised/);
  assert.throws(() => parseTranscription("health: ok\n"), /no "transcription:" line/);
  assert.equal(parseVersion("ultravox-control 0.13.5\n  binary: /x/ultravox-control\n"), "0.13.5");
  assert.throws(() => parseVersion("nonsense"), /could not read a version/);
  assert.ok(versionAtLeast("0.13.5", "0.13.0") && versionAtLeast("1.0.0", "0.13.0") && !versionAtLeast("0.12.9", "0.13.0"));
  assert.ok(isAudio("audio/ogg") && isAudio(undefined, "Note.M4A") && !isAudio("image/png", "a.png"));
});

function fakeApp(dir: string, body: string): string {
  const file = join(dir, "ultravox-control");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test("transcription runs through the control program, one at a time, and applies the extra dictionary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-uv-app-"));
  const home = homeWith({ ultravox: { enabled: true } });
  try {
    const log = join(dir, "calls.log");
    const words = join(dir, "words.txt");
    writeFileSync(words, "Acme = acme, ack me\n");
    const app = fakeApp(dir, `
case "$1" in
  version) echo "ultravox-control 0.13.5"; echo "  binary: $0";;
  transcribe) echo "start $2" >> "${log}"; sleep 0.3; echo "end $2" >> "${log}"
    case "$2" in *bad*) echo "error: audio file not found: $2"; exit 1;; esac
    echo "transcribe: ok"; echo "  path: $2"; echo "  transcription: call ack me back";;
  dictionary-apply) echo "$2" | sed 's/ack me/Acme/';;
esac`);
    const cfg = loadConfig(home);
    cfg.ultravox = { app, dictionary: words };
    const uv = new Ultravox(cfg, () => undefined);
    const [a, b] = await Promise.all([uv.transcribe("/m/one.ogg"), uv.transcribe("/m/two.ogg")]);
    assert.equal(a, "call Acme back");
    assert.equal(b, "call Acme back");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["start /m/one.ogg", "end /m/one.ogg", "start /m/two.ogg", "end /m/two.ogg"]);
    assert.equal(await voiceNote(uv, "/m/three.ogg"), "[voice note] call Acme back");
    const errors: string[] = [];
    const note = await voiceNote(uv, "/m/bad.ogg", { error: (m, d) => errors.push(`${m} ${JSON.stringify(d)}`) });
    assert.match(note, /^\[voice note at \/m\/bad.ogg could not be transcribed: audio file not found: \/m\/bad.ogg\]$/);
    assert.match(errors[0], /audio file not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("a missing or too-old app is named, not silent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-uv-app-"));
  const home = homeWith({ ultravox: { enabled: true } });
  try {
    const cfg = loadConfig(home);
    cfg.ultravox = { app: join(dir, "Nope.app") };
    await assert.rejects(new Ultravox(cfg, () => undefined).transcribe("/m/a.ogg"), /UltraVox is not installed/);
    cfg.ultravox = { app: fakeApp(dir, 'echo "ultravox-control 0.12.1"') };
    await assert.rejects(new Ultravox(cfg, () => undefined).transcribe("/m/a.ogg"), /UltraVox 0.12.1 is too old/);
    cfg.ultravox = { app: fakeApp(dir, 'echo "ultravox-control 0.13.5"; echo "boom" >&2; exit 3') };
    const bad = new Ultravox(cfg, () => undefined);
    await assert.rejects(bad.transcribe("/m/a.ogg"), /failed: .*boom/s);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

async function runSetup(detect: () => string | undefined, answer: string): Promise<{ config: any; prompts: string[] }> {
  const home = mkdtempSync(join(tmpdir(), "carl-setup-uv-"));
  const old = process.env.CARL_HOME;
  process.env.CARL_HOME = home;
  const prompts: string[] = [];
  try {
    const init = () => { try { readFileSync(join(home, "carl.json")); } catch { writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "p/m", api: { enabled: true } })); } return 0; };
    const ask = async (prompt: string) => { prompts.push(prompt); return /UltraVox/.test(prompt) ? answer : "skip"; };
    assert.equal(await setup({ init, doctor: async () => 0, ask, detectUltravox: detect }), 0);
    return { config: JSON.parse(readFileSync(join(home, "carl.json"), "utf8")), prompts };
  } finally {
    if (old === undefined) delete process.env.CARL_HOME; else process.env.CARL_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
}

test("setup offers UltraVox only when installed, default No", async () => {
  const absent = await runSetup(() => undefined, "y");
  assert.ok(!absent.prompts.some((p) => /UltraVox/.test(p)));
  assert.equal(absent.config.ultravox, undefined);
  const no = await runSetup(() => "/x/ultravox-control", "");
  assert.ok(no.prompts.some((p) => p === "Transcribe voice notes locally with UltraVox? [y/N]:"));
  assert.equal(no.config.ultravox, undefined);
  const yes = await runSetup(() => "/x/ultravox-control", "y");
  assert.deepEqual(yes.config.ultravox, { enabled: true });
});
