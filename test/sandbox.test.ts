import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { executableChain, installProfile, readSandboxed, sandboxAvailable, sandboxSpawnHook } from "../src/sandbox.ts";
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
  mkdirSync(join(root, "nest", "deep"), { recursive: true });
  writeFileSync(join(root, "nest", "deep", "ext.ts"), "// operator code\n");
  writeFileSync(join(home, "carl.json"), JSON.stringify({ extensions: [join(outside, "ext.ts")], envFiles: [join(root, "secrets", "extra.env")], shellEnv: ["CARL_TEST_PASS", "CARL_FILE_ONLY"], agentWritable: [root], api: { port: 18_765 } }));
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=1:secret\nCARL_FILE_ONLY=from-env-file\n");
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "secrets", "extra.env"), "OTHER=2:secret\n");
  const cfg = loadConfig(home);
  const api = createServer((_q, r) => r.end("api")).listen(18_765, "127.0.0.1");
  // A program Carl starts by path: the link and its folder must stay put, the folder's other files need not.
  mkdirSync(join(root, "bin"));
  symlinkSync("/bin/echo", join(root, "bin", "tool"));
  writeFileSync(join(root, "probe.py"), LS_PROBE);
  // A stand-in tmux server: its socket must be out of reach (tmux runs whatever it is sent, outside the sandbox).
  const sock = join(root, "tmux-sock", "s");
  mkdirSync(dirname(sock));
  const tmuxLike = createNetServer((c) => c.end("tmux")).listen(sock);
  const savedTmux = process.env.TMUX;
  process.env.TMUX = `${sock},1,0`;
  // A process outside the sandbox that commands must not be able to signal.
  const outsider = spawn("/bin/sleep", ["30"]);
  t.after(() => { outsider.kill(); tmuxLike.close(); if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux; });
  const homeProbe = join(homedir(), `.carl-sandbox-probe-${process.pid}`);
  t.after(() => { rmSync(homeProbe, { force: true }); rmSync(`/private/tmp/carl-sbx-probe-${process.pid}`, { force: true }); });
  const profile = installProfile(cfg, { controlPlane: [outside, join(root, "nest", "deep", "ext.ts")], pinned: executableChain(join(root, "bin", "tool")), apiPorts: [18_765] })!;
  process.env.TELEGRAM_BOT_TOKEN = "1:secret-from-env";
  process.env.STRIPE_TEST_KEY = "sk_must_not_leak";
  process.env.CARL_TEST_PASS = "passed-through";
  process.env.HOMEBREW_GITHUB_API_TOKEN = "ghp_must_not_leak";
  process.env.HTTPS_PROXY = "http://proxy.test:3128";
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
    `ln ${join(root, "secrets", "extra.env")} ${join(ws, "extra-link")}`,
    `cp -c ${join(root, "secrets", "extra.env")} ${join(ws, "extra-clone")}; cat ${join(ws, "extra-clone")}`,
    `echo pwned >> ${join(outside, "ext.ts")}`,
    `osascript -e 'return 1'`,
    `curl -s -m 3 http://127.0.0.1:18765/ ; echo curl=$?`,
    `echo fine > ${join(ws, "ok.txt")} && echo wrote-workspace`,
    `echo "KEY=[$STRIPE_TEST_KEY] PASS=[$CARL_TEST_PASS] BREW=[$HOMEBREW_GITHUB_API_TOKEN] PROXY=[$HTTPS_PROXY]"`,
    `mv ${ws} ${join(root, "ws-moved")}`,
    `mv ${join(root, "bin")} ${join(root, "bin-moved")}`,
    `ln -sf /bin/sh ${join(root, "bin", "tool")}`,
    `echo other > ${join(root, "bin", "other")} && echo wrote-beside-pinned`,
    `echo made > ${join(root, "made.txt")} && echo wrote-in-ancestor`,
    `/usr/bin/python3 ${join(root, "probe.py")}`,
    `echo nope > ${homeProbe}; echo home-write=$?`,
    `/usr/bin/python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${sock}'); print('TMUX-REACHED', s.recv(9))" 2>/dev/null || echo tmux-blocked`,
    `kill -0 ${outsider.pid} 2>/dev/null && echo SIGNAL-REACHED || echo signal-blocked`,
    `echo "PATHIS=[$PATH]" "FILEONLY=[$CARL_FILE_ONLY]"`,
    `echo t > /private/tmp/carl-sbx-probe-${process.pid}; echo tmp-write=$?`,
    `echo "TMPDIRIS=[$TMPDIR]"`,
    `SSH_AUTH_SOCK=$(ls -d /private/var/run/com.apple.launchd.*/Listeners 2>/dev/null | head -1) ssh-add -l >/dev/null 2>&1; echo ssh-agent=$?`,
    `security show-keychain-info >/dev/null 2>&1; echo keychain=$?`,
    `mv ${join(root, "nest")} ${join(root, "nest-moved")}; echo parent-move=$?`,
  ].join(" ; "));
  api.close();
  for (const k of ["TELEGRAM_BOT_TOKEN", "STRIPE_TEST_KEY", "CARL_TEST_PASS", "HOMEBREW_GITHUB_API_TOKEN", "HTTPS_PROXY"]) delete process.env[k];
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
  assert.match(out, /KEY=\[\] PASS=\[passed-through\] BREW=\[\] PROXY=\[http:\/\/proxy.test:3128\]/, "only allowlisted and shellEnv names reach the shell");
  assert.ok(!existsSync(join(ws, "extra-link")), "a secret outside CARL_HOME cannot be hardlinked");
  assert.ok(existsSync(ws) && !existsSync(join(root, "ws-moved")), "a working area cannot be moved or replaced");
  assert.ok(lstatSync(join(root, "bin", "tool")).isSymbolicLink() && !existsSync(join(root, "bin-moved")), "a pinned program link and its folder stay put");
  assert.match(out, /wrote-beside-pinned/);
  assert.match(out, /wrote-in-ancestor/, "protecting a folder from renames does not stop new files in it");
  assert.match(out, /default-app none/, "LaunchServices is out of reach");
  assert.ok(!existsSync(homeProbe) && /home-write=1/.test(out), "nothing outside the working areas and scratch space is writable");
  assert.match(out, /tmux-blocked/, "terminal servers' sockets are out of reach");
  assert.match(out, /signal-blocked/, "processes outside the sandbox cannot be signalled");
  assert.ok(out.includes(`PATHIS=[${process.env.PATH}]`), "agent commands get the operator's PATH, nothing prefixed");
  assert.match(out, /FILEONLY=\[from-env-file\]/, "a shellEnv name can come from the env files");
  assert.match(out, /tmp-write=1/, "the shared /tmp is closed (other programs read what is there)");
  assert.ok(out.includes(`TMPDIRIS=[${join(home, "spill", "tmp")}]`), "the agent gets its own temp folder");
  assert.match(out, /ssh-agent=2/, "the operator's SSH agent is out of reach");
  assert.doesNotMatch(out, /keychain=0/, "the Keychain is out of reach");
  assert.ok(existsSync(join(root, "nest", "deep", "ext.ts")) && /parent-move=1/.test(out), "a folder above protected code cannot be moved aside, even inside a writable folder");
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
  // Carl's own reads of notes in the agent's areas (context files) go through the sandbox as well.
  assert.throws(() => readSandboxed(profile, join(ws, "env")), /not permitted/i);
  writeFileSync(join(ws, "MEMORY.md"), "notes\n");
  assert.equal(readSandboxed(profile, join(ws, "MEMORY.md")), "notes\n");
  // A device that never ends is cut off instead of filling Carl's memory.
  await assert.rejects(read.readFile("/dev/zero"), /larger than/);
  assert.equal(await read.detectImageMimeType!("/dev/zero"), null);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.alloc(17)]);
  writeFileSync(join(ws, "pic.png"), png);
  assert.equal(await read.detectImageMimeType!(join(ws, "pic.png")), "image/png");
});
