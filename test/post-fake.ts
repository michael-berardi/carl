// A fake command runner for the post tests: overseer-browser (a tiny X) and retex (absent, or a recorder).
import type { Runner } from "../src/post/types.ts";

export interface FakeX {
  run: Runner;
  /** Every command line, as "<cmd> <args...>" without the eval source. */
  calls: string[];
  /** Posts live on the fake profile, in order. */
  live: { url: string; text: string }[];
  /** Texts the composer was filled with, in order. */
  filled: string[];
  clicks: number;
  /** Throw (as a failed overseer-browser call) on the n-th find, 1-based, after the click that preceded it. */
  failFind?: (n: number) => boolean;
  /** The composer shows this instead of what was pasted (a doubled insert). */
  mangle?: (text: string) => string;
  retex?: "absent" | { hash: string };
  retexSets: string[][];
}

export function fakeX(opts: { retex?: FakeX["retex"] } = {}): FakeX {
  const state: FakeX = { calls: [], live: [], filled: [], clicks: 0, retexSets: [], retex: opts.retex ?? "absent", run: undefined as never };
  let composer = "";
  let finds = 0;
  let n = 1000;
  state.run = async (cmd, args) => {
    if (cmd === "retex") {
      state.calls.push(`retex ${args.join(" ")}`);
      if (state.retex === "absent" || !state.retex) return { code: 127, stdout: "", stderr: "retex: not found" };
      if (args[0] === "show") return { code: 0, stdout: JSON.stringify({ contentHash: state.retex.hash }), stderr: "" };
      if (args[0] === "set") { state.retexSets.push(args); return { code: 0, stdout: "{}", stderr: "" }; }
      return { code: 1, stdout: "", stderr: "?" };
    }
    const sub = args.slice(args.indexOf("--timeout") + 2).filter((a) => a !== "--json");
    const reply = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
    if (sub[0] === "eval") {
      const src = sub[1];
      state.calls.push(`${cmd} ${args.slice(0, args.indexOf("--timeout") + 2).join(" ")} eval`);
      if (src.includes("composer not found")) {
        const m = src.match(/setData\('text\/plain', ("(?:[^"\\]|\\.)*")\)/)!;
        const text: string = JSON.parse(m[1]);
        state.filled.push(text);
        composer = state.mangle ? state.mangle(text) : text;
        return reply({ ok: true, result: JSON.stringify({ text: composer, button: { label: "Post", disabled: false } }) });
      }
      if (src.includes("clicked: button")) {
        state.clicks++;
        state.live.push({ url: `https://x.com/example/status/${n++}`, text: composer });
        return reply({ ok: true, result: JSON.stringify({ clicked: "Post" }) });
      }
      if (src.includes("post not found on the page")) {
        finds++;
        if (state.failFind?.(finds)) return { code: 1, stdout: JSON.stringify({ ok: false, error: "timeout" }), stderr: "" };
        const want: string = JSON.parse(src.match(/const want = ("(?:[^"\\]|\\.)*")\.replace/)![1]);
        const hit = state.live.find((p) => p.text.replace(/\s+/g, " ").trim().startsWith(want.replace(/\s+/g, " ").trim().slice(0, 80)));
        return reply({ ok: true, result: JSON.stringify(hit ? { url: hit.url } : { error: "post not found on the page" }) });
      }
      return reply({ ok: true, result: "null" });
    }
    state.calls.push(`${cmd} ${args.filter((a) => a !== "--json").join(" ")}`);
    return reply({ ok: true });
  };
  return state;
}
