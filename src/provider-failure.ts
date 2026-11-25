// A run can fail because the provider refused the request (login gone, quota used, model unavailable to the account)
// rather than because Carl did something wrong. Those failures are infrastructure: they are logged and shown by doctor,
// but they must not become behaviour lessons or operator questions in the individuation pass.
import { ClaudeCodeError } from "./providers/claude-code.ts";

// Words the providers themselves use, plus the HTTP statuses a Claude Code refusal carries. Quota text matches the
// router's exhaustion signals so a benchable provider refusal and a shadow infrastructure entry agree.
const PROVIDER_ACCESS = /(?:(?:^|(?:HTTP|status|code)\s*[:=]?\s*)\b(?:401|402|429)\b|\b(?:401|402|429)\s+(?:Unauthorized|Payment Required|Too Many Requests)\b)|invalid (?:x-)?api[- ]?key|authentication_error|rate.?limit|usage limit|session limit|weekly limit|limit reached|quota|insufficient_quota|insufficient credits|credit balance|not logged in|not authenticated|token\s+(?:has\s+)?expired|auth(?:entication)?[-_ ]?expired|oauth session expired|login\s+(?:has\s+)?expired|expired or revoked|no credentials|unsupported model|model[^\n]{0,80}(?:is\s+)?not supported|not (?:available|supported) (?:on|for) (?:your|this) (?:plan|account)/i;

/** True when a run failure came from provider access, not from Carl's behaviour. */
export function isProviderAccessFailure(error: unknown): boolean {
  if (error instanceof ClaudeCodeError && (error.status === 401 || error.status === 402 || error.status === 429)) return true;
  const text = typeof error === "string" ? error
    : error instanceof Error ? error.message
    : error && typeof error === "object" ? String((error as { errorMessage?: unknown }).errorMessage ?? (error as { message?: unknown }).message ?? "")
    : "";
  return PROVIDER_ACCESS.test(text);
}
