import { POST_HELP, POST_OPTIONS } from "./post/cli.ts";
export const GATEWAY_OPTIONS = { verbose: { type: "boolean", short: "v" } } as const;
export const ASK_OPTIONS = { conversation: { type: "string", short: "c" } } as const;
export const SEND_OPTIONS = { to: { type: "string", short: "t" }, json: { type: "boolean" } } as const;
export const USAGE: Record<string, string> = {
  gateway: "[--verbose]  run the gateway",
  setup: "  interactive first-time setup",
  update: "[--check|--rollback]  check, install or roll back a release",
  init: "  create a starter configuration",
  status: "[--json]  show gateway status",
  doctor: "  check configuration and connections",
  ask: "[-c key] <text>  ask one question",
  send: "-t telegram:<chat> [--json] <text>  send a message",
  "ask-post": "<id>  post an ask's questions",
  reflect: "[--pending|--revert <id>]  run or inspect the individuation pass",
  schedules: "  list schedules",
  post: "<command>  draft posts",
  prompt: "[--full]  inspect the system prompt",
  app: "[--install]  open or install the web app",
  login: "[provider] [--api-key]  list providers or sign in",
  logout: "<provider>  remove credentials",
  version: "  show version",
};
function optionHelp(options: Record<string, { type: string; short?: string }>): string {
  return Object.entries(options).map(([name, o]) => `  --${name}${o.short ? `, -${o.short}` : ""}${o.type === "string" ? " <value>" : ""}`).join("\n");
}
export function commandHelp(cmd: string, args: string[]): string {
  if (cmd === "post") {
    const verb = args[0];
    return verb && !verb.startsWith("-") ? `Usage: carl post ${verb}\n\n${POST_HELP}\n\nOptions:\n${optionHelp(POST_OPTIONS)}` : `Usage: carl post <command>\n\n${POST_HELP}`;
  }
  const nested = cmd === "update" && ["--rollback", "--check"].includes(args[0]) || cmd === "reflect" && ["pending", "revert", "--pending", "--revert"].includes(args[0]) ? ` ${args[0]}` : "";
  const options = cmd === "gateway" ? GATEWAY_OPTIONS : cmd === "ask" ? ASK_OPTIONS : cmd === "send" ? SEND_OPTIONS : undefined;
  return `Usage: carl ${cmd}${nested} ${USAGE[cmd]}${options ? `\n\nOptions:\n${optionHelp(options)}` : ""}`;
}
const HELP_FLAGS = new Set(["--help", "-h"]);
/** Help is the first argument, or the one right after a nested verb (`carl post schedule --help`, `carl update --rollback -h`).
 *  A "--help" anywhere else is data: `carl send -t telegram:1 "use --help"` and `carl ask -- --help` must send and ask. */
export function helpRequested(cmd: string, args: string[]): boolean {
  if (args.includes("--")) return HELP_FLAGS.has(args[0]) && args.indexOf("--") > 0;
  if (HELP_FLAGS.has(args[0])) return true;
  const verb = args[0];
  const nested = cmd === "post" ? verb !== undefined && !verb.startsWith("-")
    : cmd === "update" ? verb === "--rollback" || verb === "--check"
    : cmd === "reflect" ? ["pending", "revert", "--pending", "--revert"].includes(verb ?? "")
    : false;
  return nested && HELP_FLAGS.has(args[1]);
}
export function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length];
}

