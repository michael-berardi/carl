// Shell guard: hardline commands are always blocked; dangerous ones need the operator's explicit approval.
// Unattended runs (schedules, API without a chat) cannot ask, so dangerous commands are refused there.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

export type Verdict = { level: "ok" } | { level: "dangerous" | "hardline"; reason: string };

const HARDLINE: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force|--force\s+--recursive)\s+(\/|\/\*|~|~\/\*|\$HOME|\$HOME\/\*|\/Users|\/Users\/[^/\s]+|\/(System|Library|Applications|usr|bin|etc|var|opt))\/?(\s|$|[;&|])/i, "recursive delete of a root, system or home directory"],
  [/\b(mkfs|newfs|diskutil\s+(erase|zero|secureErase|partitionDisk))\b/i, "disk format or erase"],
  [/\bdd\s+[^|;]*\bof=\/dev\//i, "raw write to a device"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/\b(shutdown|halt|reboot)\b(\s|$)/i, "machine shutdown or reboot"],
  [/\bsudo\b/i, "sudo"],
  [/\bgit\s+push\b[^;&|]*(--force\b|-f\b|--force-with-lease\b)[^;&|]*\b(main|master)\b/i, "force push to main"],
  [/\bcf\s+deploy\b/i, "bare `cf deploy` (deletes undeclared secrets; use cf-deploy.mjs)"],
];

const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r|-[a-z]*f|--recursive|--force)/i, "recursive or forced delete"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--?\s*\.|restore\s+\.|branch\s+-D|push\s+[^;&|]*(--force|-f\b|--delete|:))/i, "destructive git"],
  [/\bgit\s+push\b/i, "git push"],
  [/\b(kill|pkill|killall)\b/i, "killing processes"],
  [/\b(launchctl\s+(load|bootstrap|unload|bootout|remove)|crontab\s+-[re])\b/i, "background services or schedules"],
  [/\bchmod\s+(-R\s+)?[0-7]*7[0-7]{0,2}\b|\bchown\s+-R\b/i, "permission changes"],
  [/(>|tee\s+(-a\s+)?)\s*~?\/?[^\s;|&]*\/(\.ssh|\.aws|\.gnupg)\//i, "writes to credential directories"],
  [/(>|tee\s+(-a\s+)?)\s*[^\s;|&]*(\.env|auth\.json|\.zshrc|\.bashrc|\.zprofile|\.profile)\b/i, "writes to secrets or shell startup files"],
  [/\b(curl|wget)\b[^|;&]*\|\s*(ba|z)?sh\b/i, "piping a download into a shell"],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+(repo\s+(create|delete|edit)|release\s+create|pr\s+merge)\b/i, "publishing"],
  [/\b(wrangler|cf)\s+(d1\s+[^;&|]*\b(execute|migrations\s+apply)|kv\s+[^;&|]*\b(delete|put)|r2\s+[^;&|]*\bdelete|secret\s+(put|delete))/i, "production data or secrets"],
  [/\bdeploy(\.sh|\.mjs)?\b|\bnpm\s+run\s+deploy\b/i, "deploy"],
  [/\bstripe\b[^;&|]*\b(subscriptions?|prices?|invoices?|refunds?)\b[^;&|]*\b(update|cancel|create|delete)\b/i, "billing change"],
];

export function classifyCommand(command: string): Verdict {
  for (const [re, reason] of HARDLINE) if (re.test(command)) return { level: "hardline", reason };
  for (const [re, reason] of DANGEROUS) if (re.test(command)) return { level: "dangerous", reason };
  return { level: "ok" };
}

export type Approver = (command: string, reason: string) => Promise<"approved" | "denied" | "timeout" | "unattended">;

/** A Pi extension that gates the bash tool for one conversation. */
export function shellGuard(approve: Approver, onBlock: (command: string, why: string) => void): InlineExtension {
  return {
    name: "carl-shell-guard",
    factory: (pi: ExtensionAPI) => {
      pi.on("tool_call", async (event: any) => {
        if (event.toolName !== "bash") return undefined;
        const command = String(event.input?.command ?? "");
        const verdict = classifyCommand(command);
        if (verdict.level === "ok") return undefined;
        if (verdict.level === "hardline") {
          onBlock(command, `hardline: ${verdict.reason}`);
          return { block: true, reason: `Blocked: ${verdict.reason}. This command is never run by Carl; ask the operator to run it themselves.` };
        }
        const answer = await approve(command, verdict.reason);
        if (answer === "approved") return undefined;
        onBlock(command, `${verdict.reason} (${answer})`);
        const why = answer === "unattended" ? "no operator is attached to this run to approve it" : answer === "timeout" ? "the operator did not answer within 5 minutes" : "the operator denied it";
        return { block: true, reason: `Not run (${verdict.reason}): ${why}.` };
      });
    },
  } as unknown as InlineExtension;
}
