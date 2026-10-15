import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { executableChain, installProfile, sandboxAvailable, sandboxSpawnHook } from "../src/sandbox.ts";
import { guardedFileOps, guardedReadOps } from "../src/guard.ts";

const base = join(tmpdir(), "carl-test-sandbox");
// A LaunchServices lookup with no side effect: it finds the default browser unless LaunchServices is blocked.
const LS_PROBE = `import ctypes, ctypes.util
cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
cs = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreServices.framework/CoreServices")
cf.CFURLCreateWithBytes.restype = ctypes.c_void_p
cf.CFURLCreateWithBytes.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32, ctypes.c_void_p]
u = b"https://example.com/"
url = cf.CFURLCreateWithBytes(None, u, len(u), 0x08000100, None)
cs.LSCopyDefaultApplicationURLForURL.restype = ctypes.c_void_p
cs.LSCopyDefaultApplicationURLForURL.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]
print("default-app", "found" if cs.LSCopyDefaultApplicationURLForURL(url, 0xFFFFFFFF, None) else "none")
`;

test("shell sandbox: control plane and secrets are out of reach, the workspace is not", { skip: !sandboxAvailable() && "needs macOS sandbox-exec" }, async (t) => {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "run-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); try { rmdirSync(base); } catch {} });
  const home = join(root, "carl");
  for (const d of ["state", "workspace", "pi"]) mkdirSync(join(home, d), { recursive: true });
  const outside = join(root, "elsewhere-ext");
  mkdirSync(outside);
  writeFileSync(join(outside, "ext.ts"), "// operator code\n");
  writeFileSync(join(home, "carl.json"), JSON.stringify({ extensions: [join(outside, "ext.ts")], envFiles: [join(root, "secrets", "extra.env")], shellEnv: ["CARL_TEST_PASS"], api: { port: 18_765 } }));
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=1:secret\n");
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "secrets", "extra.env"), "OTHER=2:secret\n");
  const cfg = loadConfig(home);
  const api = createServer((_q, r) => r.end("api")).listen(18_765, "127.0.0.1");
  // A program Carl starts by path: the link and its folder must stay put, the folder's other files need not.
  mkdirSync(join(root, "bin"));
  symlinkSync("/bin/echo", join(root, "bin", "tool"));
  writeFileSync(join(root, "probe.py"), LS_PROBE);
  const profile = installProfile(cfg, { controlPlane: [outside], pinned: executableChain(join(root, "bin", "tool")), apiPorts: [18_765] })!;
  process.env.TELEGRAM_BOT_TOKEN = "1:secret-from-env";
  process.env.STRIPE_TEST_KEY = "sk_must_not_leak";
  process.env.CARL_TEST_PASS = "passed-through";
  const bash = createBashToolDefinition(cfg.workspace, { spawnHook: sandboxSpawnHook(cfg, profile), exposeSessionEnvironment: false });
  const run = async (command: string) => {
    const r: any = await bash.execute("t", { command } as any, undefined, undefined, {} as any).catch((e: Error) => ({ content: [{ type: "text", text: e.message }] }));
    return (r.content ?? []).map((c: any) => c.text).join("\n");
  };
  const ws = cfg.workspace;
  const out = await run([
    `echo hacked >> ${join(home, "carl.json")}`,
    `cat ${join(home, ".env")}`,
    `echo "TOKEN=[$TELEGRAM_BOT_TOKEN]"`,
    `echo ext > ${join(home, "pi", "x.ts")}`,
    `mkdir -p ${join(ws, ".pi")} && echo y > ${join(ws, ".pi", "y.ts")}`,
    `ln ${join(home, ".env")} ${join(ws, "env-link")}`,
    `mv ${join(home, ".env")} ${join(ws, "env-moved")}`,
    `ln ${join(home, "carl.json")} ${join(ws, "config-link")}`,
    `mv ${join(root, "secrets")} ${join(ws, "secrets-moved")}`,
    `cat ${join(root, "secrets", "extra.env")}`,
    `echo pwned >> ${join(outside, "ext.ts")}`,
    `osascript -e 'return 1'`,
    `curl -s -m 3 http://127.0.0.1:18765/ ; echo curl=$?`,
    `echo fine > ${join(ws, "ok.txt")} && echo wrote-workspace`,
    `echo "KEY=[$STRIPE_TEST_KEY] PASS=[$CARL_TEST_PASS]"`,
    `mv ${ws} ${join(root, "ws-moved")}`,
    `mv ${join(root, "bin")} ${join(root, "bin-moved")}`,
    `ln -sf /bin/sh ${join(root, "bin", "tool")}`,
    `echo other > ${join(root, "bin", "other")} && echo wrote-beside-pinned`,
    `echo made > ${join(root, "made.txt")} && echo wrote-in-ancestor`,
    `/usr/bin/python3 ${join(root, "probe.py")}`,
  ].join(" ; "));
  api.close();
  for (const k of ["TELEGRAM_BOT_TOKEN", "STRIPE_TEST_KEY", "CARL_TEST_PASS"]) delete process.env[k];
  assert.equal(readFileSync(join(home, "carl.json"), "utf8").includes("hacked"), false, "carl.json must be unchanged");
  assert.doesNotMatch(out, /1:secret|2:secret/, "neither the .env files nor the env var may leak");
  assert.ok(!existsSync(join(ws, "config-link")), "control files cannot be hardlinked into the workspace");
  assert.ok(existsSync(join(root, "secrets", "extra.env")) && !existsSync(join(ws, "secrets-moved")), "a folder holding a secret cannot be moved somewhere readable");
  assert.match(out, /TOKEN=\[\]/);
  assert.ok(!existsSync(join(home, "pi", "x.ts")), "no writes into Carl's Pi dir");
  assert.ok(!existsSync(join(ws, ".pi", "y.ts")), "no Pi extension dir inside the workspace");
  assert.ok(!existsSync(join(ws, "env-link")) && !existsSync(join(ws, "env-moved")), "secrets cannot be linked or moved out");
  assert.equal(readFileSync(join(outside, "ext.ts"), "utf8"), "// operator code\n", "control-plane code outside CARL_HOME is protected");
  assert.doesNotMatch(out, /\bapi\b/, "Carl's own API port is unreachable from the shell");
  assert.match(out, /curl=7|curl=28/);
  assert.match(out, /wrote-workspace/);
  assert.match(out, /KEY=\[\] PASS=\[passed-through\]/, "only allowlisted and shellEnv names reach the shell");
  assert.ok(existsSync(ws) && !existsSync(join(root, "ws-moved")), "a working area cannot be moved or replaced");
  assert.ok(lstatSync(join(root, "bin", "tool")).isSymbolicLink() && !existsSync(join(root, "bin-moved")), "a pinned program link and its folder stay put");
  assert.match(out, /wrote-beside-pinned/);
  assert.match(out, /wrote-in-ancestor/, "protecting a folder from renames does not stop new files in it");
  assert.match(out, /default-app none/, "LaunchServices is out of reach");
});

test("file tools: reads and writes run in the sandbox, so a swapped symlink gains nothing", { skip: !sandboxAvailable() && "needs macOS sandbox-exec" }, async (t) => {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "ops-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); try { rmdirSync(base); } catch {} });
  const home = join(root, "carl");
  for (const d of ["state", "workspace", "pi"]) mkdirSync(join(home, d), { recursive: true });
  // A secret whose name the guard does not recognise: only the kernel knows it is one.
  writeFileSync(join(root, "vault.txt"), "VAULT=3:secret\n");
  writeFileSync(join(home, "carl.json"), JSON.stringify({ envFiles: [join(root, "vault.txt")] }));
  const cfg = loadConfig(home);
  const profile = installProfile(cfg, { controlPlane: [], apiPorts: [] })!;
  const ws = cfg.workspace;
  // The guard's rules say nothing about this route: only the kernel stands between the tool and Carl's files.
  const rules = { sandboxProfile: profile };
  const ops = guardedFileOps(rules);
  const read = guardedReadOps(rules);
  await ops.mkdir(join(ws, "notes"));
  await ops.writeFile(join(ws, "notes", "a.md"), "hello\n");
  assert.equal(readFileSync(join(ws, "notes", "a.md"), "utf8"), "hello\n");
  assert.equal(String(await read.readFile(join(ws, "notes", "a.md"))), "hello\n");
  await read.access(join(ws, "notes", "a.md"));
  await assert.rejects(read.access(join(ws, "missing.md")), { code: "ENOENT" });
  // A folder swapped for a link to Carl's Pi dir, and a link to the secrets file.
  rmSync(join(ws, "notes"), { recursive: true });
  symlinkSync(join(home, "pi"), join(ws, "notes"));
  symlinkSync(join(root, "vault.txt"), join(ws, "env"));
  await assert.rejects(ops.writeFile(join(ws, "notes", "ext.ts"), "pwned"), /not permitted/i);
  assert.ok(!existsSync(join(home, "pi", "ext.ts")));
  await assert.rejects(read.readFile(join(ws, "env")), /not permitted/i);
  await assert.rejects(ops.writeFile(join(ws, "env"), "x"), /not permitted/i);
  assert.equal(readFileSync(join(root, "vault.txt"), "utf8"), "VAULT=3:secret\n");
  assert.equal(typeof read.detectImageMimeType, "function", "images are still recognised");
});
