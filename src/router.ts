// Model routing: the primary model first; the next model in the chain only when the primary provably cannot answer.
// "Provably" means the provider said so: out of quota or credits (a plan, usage or session limit, HTTP 402/429), the
// route has no endpoints (OpenRouter's 404 "No endpoints available"), or a 5xx outage before any output. Anything
// else (a bad login, a malformed request, an unknown error) fails with its own named cause instead of quietly
// moving the work to another model. A model that failed stays benched for its reset hint, or a short cooldown when
// it gave none. A provider's content-filter refusal (an HTTP 400 naming a content-inspection code) judges the input,
// not the model: the next model answers that turn and the model is not benched. A local model server that is down or
// refused by its manager (see isLocalUnavailable) is an outage of that model: benched for 2 minutes, the next model answers.
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

const QUOTA = /\b(402|429)\b|rate.?limit|usage limit|session limit|weekly limit|limit reached|quota|insufficient_quota|insufficient credits|billing|credit balance|resets? (at|in)\b/i;
// 5xx only when the message names a status: "HTTP 503", "status 502", "code 500", "5xx". A bare number in a reset
// hint ("resets in 500 seconds") is not an outage.
const OUTAGE = /(?:http(?:\/\d(?:\.\d)?)?|status|code)\s*[:=]?\s*5\d\d\b|\b5xx\b|bad gateway|service unavailable|gateway time-?out|internal server error|overloaded/i;
const NO_ENDPOINTS = /no endpoints? (?:available|found)|no available (?:endpoints?|providers?)|no provider (?:available|found)/i;
// The signed-in account's plan cannot run this model at all (a lapsed paid login that fell back to a free plan, say). Like a
// quota refusal it is the provider saying no before any output, so the next model in the chain answers instead of every run failing.
const PLAN_REFUSED = /model is not supported when using \w+ with a [\w ]+account|not (?:available|supported) (?:on|for) (?:your|this) (?:plan|account)|requires? a (?:paid|pro|plus|team) (?:plan|subscription)/i;
// A provider's input inspection refused the request before output: an HTTP 400 whose error code or type names content
// inspection, moderation or safety filtering (data_inspection_failed, content_policy_violation, ...). Matched by that
// shape only, never by provider name.
const CONTENT_FILTER_CODE = /\b(?:data_inspection_failed|content_filter|content_policy_violation|content_moderation|moderation_blocked|safety_filter|safety_violation|responsible_ai_policy_violation)\b/i;

// A local model server (llama-server started on demand by a local-model manager) that cannot answer before any output:
// either the manager refused to start it (`steak-pi local: REFUSED (on-hold|quiet-day|insufficient-memory|other-server|...)`)
// or nothing listens on a loopback address (ECONNREFUSED 127.0.0.1 / ::1 / localhost). A refusal to connect to a remote
// host is not matched: only a server on this machine counts as a local outage.
const LOCAL_REFUSED = /\bsteak-pi local: REFUSED \([\w-]+\)/i;
// The address right after ECONNREFUSED (Node prints `connect ECONNREFUSED <addr>:<port>`), as a whole address: `::1` at
// the end of a remote IPv6 address or a loopback-looking word later on the line does not count.
const LOOPBACK_REFUSED = /\bECONNREFUSED\s+(?:127\.\d+\.\d+\.\d+|::1|\[::1\]|localhost)(?=:\d|[\s)\]]|$)/i;
const LOCAL_DOWN = /\blocal server at \S+ is not answering\b/i;
const BARE_CONNECTION_ERROR = /^\s*(?:connection error|fetch failed|network error|unable to connect)\.?\s*$/i;
const LOOPBACK_URL = /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;

/** True when the failure says the local model server cannot answer: a local-manager refusal or a refused loopback connection. */
export function isLocalUnavailable(message: string | undefined, baseUrl?: string): boolean {
  if (typeof message !== "string") return false;
  if (LOCAL_REFUSED.test(message) || LOOPBACK_REFUSED.test(message) || LOCAL_DOWN.test(message)) return true;
  return !!baseUrl && LOOPBACK_URL.test(baseUrl) && BARE_CONNECTION_ERROR.test(message);
}

/**
 * A bare connection error from a model whose baseUrl is loopback gets its cause named; any other message is unchanged.
 * Every loopback provider counts (a local-model manager's server, or a gateway or proxy you run on this machine): a bare
 * connection error from one is a server that is down on this machine, and the next model answers.
 */
export function nameLocalCause(message: string, baseUrl?: string): string {
  return baseUrl && LOOPBACK_URL.test(baseUrl) && BARE_CONNECTION_ERROR.test(message) && !LOCAL_DOWN.test(message)
    ? `${message.trim()} (local server at ${baseUrl} is not answering)` : message;
}

/** True when the message is an HTTP 400 that names a content-inspection, moderation or safety-filter code or type. */
export function isContentFilter(message: string | undefined): boolean {
  return typeof message === "string" && /\b400\b/.test(message) && CONTENT_FILTER_CODE.test(message);
}

export function isExhaustion(message: Pick<AssistantMessage, "stopReason" | "errorMessage"> | undefined): boolean {
  if (!message || message.stopReason !== "error") return false;
  const text = message.errorMessage ?? "";
  return QUOTA.test(text) || OUTAGE.test(text) || NO_ENDPOINTS.test(text) || PLAN_REFUSED.test(text) || isContentFilter(text) || isLocalUnavailable(text);
}

/** True when the failure is a provider outage or a route with no endpoints, not a quota refusal. */
export function isOutage(message: Pick<AssistantMessage, "stopReason" | "errorMessage"> | undefined): boolean {
  if (!message || message.stopReason !== "error") return false;
  const text = message.errorMessage ?? "";
  return !QUOTA.test(text) && (OUTAGE.test(text) || NO_ENDPOINTS.test(text) || isLocalUnavailable(text));
}

/**
 * How long to bench the failed model: the provider's own reset hint when it gave one, 2 minutes after a 5xx outage,
 * 10 minutes for a route with no endpoints (the model or its provider set is unavailable), else the default.
 */
export function cooldownMs(errorMessage: string, now = Date.now(), fallbackMs = 30 * 60_000): number {
  // An input refusal says nothing about the model: the next turn may be served by it, so nothing is benched.
  if (isContentFilter(errorMessage)) return 0;
  const rel = errorMessage.match(/resets? in (\d+)\s*(m|min|minutes?|h|hours?)/i);
  if (rel) return Number(rel[1]) * (rel[2][0].toLowerCase() === "h" ? 3_600_000 : 60_000);
  const abs = errorMessage.match(/resets? at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (abs) {
    let h = Number(abs[1]) % 12 + (abs[3]?.toLowerCase() === "pm" ? 12 : 0);
    if (!abs[3] && Number(abs[1]) >= 12) h = Number(abs[1]);
    const at = new Date(now);
    at.setHours(h, Number(abs[2] ?? 0), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime() - now;
  }
  if (PLAN_REFUSED.test(errorMessage)) return 6 * 3_600_000;  // a plan does not change by itself: re-test in a few hours
  if (NO_ENDPOINTS.test(errorMessage)) return 10 * 60_000;
  if (OUTAGE.test(errorMessage) || isLocalUnavailable(errorMessage)) return 2 * 60_000;
  return fallbackMs;
}

export interface RouterEvents {
  /** `metered` is true when the model taken on is pay-per-use (see carl.json meteredFallbackModels). */
  onFallback(from: string, to: string, reason: string, untilMs: number, metered: boolean): void;
}

/** Route definition for ModelRuntime.registerVirtualModel. */
export function createRouter(opts: { primary: string | (() => string); fallbacks: string[] | (() => string[]); resolve: (ref: string) => Model<Api>; events: RouterEvents;
  /** Whether a model is pay-per-use. Absent means none is. */
  metered?: (ref: string) => boolean;
  /** Whether a model can be called at all (its provider has a login). A model without one is skipped, never routed to:
   * 2026-10-29 the primary had no Codex login and every turn failed with "has no credentials" while Sonnet sat unused. */
  usable?: (ref: string) => boolean }) {
  const exhaustedUntil = new Map<string, number>();
  const ref = (m: Model<Api>) => `${m.provider}/${m.id}`;
  const usable = (r: string) => { try { return opts.usable ? opts.usable(r) : true; } catch { return true; } };
  const available = (r: string) => (exhaustedUntil.get(r) ?? 0) <= Date.now() && usable(r);
  const primaryOf = () => (typeof opts.primary === "function" ? opts.primary() : opts.primary);
  const fallbacksOf = () => (typeof opts.fallbacks === "function" ? opts.fallbacks() : opts.fallbacks);
  return {
    exhaustedUntil,
    route(request: any) {
      const chain = [primaryOf(), ...fallbacksOf().filter((f) => f !== primaryOf())];
      if (request.reason === "retry" && request.failed && isExhaustion({ stopReason: "error", errorMessage: nameLocalCause(request.failed.message.errorMessage ?? "", request.failed.model.baseUrl) })) {
        const failed = ref(request.failed.model);
        const named = nameLocalCause(request.failed.message.errorMessage ?? "", request.failed.model.baseUrl);
        // Move the work only when the failure produced nothing: a partial answer or a started tool call belongs to
        // the model that wrote it. A failed retry arrives here with the failed message stripped from `messages`.
        const silent = !(request.failed.message.content?.length);
        const ms = cooldownMs(named);
        exhaustedUntil.set(failed, Date.now() + ms);
        const next = silent ? chain.find((r) => r !== failed && available(r)) : undefined;
        if (next) {
          opts.events.onFallback(failed, next, named.slice(0, 200), Date.now() + ms, opts.metered?.(next) ?? false);
          return { model: opts.resolve(next), thinkingLevel: request.thinkingLevel };
        }
        // The failure came after output: finish this turn on the model that started it (its caches and tool calls
        // belong to it). The model is benched either way, so the next turn starts on the next tier.
        if (!silent) return { model: request.failed.model, thinkingLevel: request.thinkingLevel };
      }
      // Tool follow-ups and ordinary retries stay on the model that handled the turn (caches, signatures).
      const sticky = request.reason === "retry" ? request.failed : request.previous;
      if (request.reason !== "user" && sticky && available(ref(sticky.model))) {
        return { model: sticky.model, thinkingLevel: request.thinkingLevel };
      }
      const pick = chain.find(available) ?? primaryOf();
      return { model: opts.resolve(pick), thinkingLevel: request.thinkingLevel };
    },
  };
}
