import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("init seeds the OpenRouter Exacto default and preserves an existing model on rerun", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-init-"));
  try {
    const init = () => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", main, "init"], {
      env: { ...process.env, CARL_HOME: home }, encoding: "utf8",
    });
    const first = init();
    assert.equal(first.status, 0, first.stderr);
    const file = join(home, "carl.json");
    const seeded = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(seeded.model, "opencode-go/deepseek-v4.1-flash");
    assert.deepEqual(seeded.fallbackModels, ["openrouter/deepseek/deepseek-v4.1-flash-1017:exacto", "openai-codex/gpt-6.1-terra", "claude-code/claude-sonnet-5-5"]);
    const existing = JSON.stringify({ model: "openai-codex/gpt-6.1-sol" });
    writeFileSync(file, existing);
    const second = init();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(file, "utf8"), existing);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
