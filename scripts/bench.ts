// Benchmark any OpenAI-compatible agent endpoint against another on the same prompts.
// Usage: node --experimental-strip-types scripts/bench.ts --prompts prompts.json --out results.json \
//          --target name=URL,KEY_ENV[,header:value] [--target ...]
// Each prompt runs once per target in a fresh conversation. Reports wall time and the usage each endpoint returns.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { prompts: { type: "string" }, out: { type: "string" }, target: { type: "string", multiple: true }, envfile: { type: "string" } } });
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
if (values.envfile) for (const line of readFileSync(values.envfile, "utf8").split("\n")) {
  const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const prompts: { id: string; text: string }[] = JSON.parse(readFileSync(values.prompts!, "utf8"));
const targets = (values.target ?? []).map((t) => {
  const [name, rest] = t.split("=");
  const [url, keyEnv, header] = rest.split(",");
  if (!env[keyEnv]) throw new Error(`${keyEnv} is not set`);
  return { name, url, key: env[keyEnv], header };
});
const results: any[] = [];
for (const p of prompts) {
  for (const t of targets) {
    const conv = `bench-${p.id}-${Date.now().toString(36)}`;
    const headers: Record<string, string> = { authorization: `Bearer ${t.key}`, "content-type": "application/json" };
    if (t.header) headers[t.header.split(":")[0]] = t.header.split(":")[1].replace("{conv}", conv);
    const started = Date.now();
    let row: any = { prompt: p.id, target: t.name };
    try {
      const res = await fetch(t.url, { method: "POST", headers, body: JSON.stringify({ model: "default", user: conv, messages: [{ role: "user", content: p.text }] }), signal: AbortSignal.timeout(600_000) });
      const body: any = await res.json();
      row = { ...row, status: res.status, ms: Date.now() - started, usage: body.usage, answer: String(body.choices?.[0]?.message?.content ?? body.error?.message ?? "").slice(0, 600) };
    } catch (e) {
      row = { ...row, ms: Date.now() - started, error: (e as Error).message };
    }
    results.push(row);
    console.log(`${p.id.padEnd(14)} ${t.name.padEnd(8)} ${String(row.ms).padStart(7)} ms  usage=${JSON.stringify(row.usage ?? row.error)}`);
  }
}
writeFileSync(values.out!, JSON.stringify(results, null, 2));
