// Per-model guidance: short system-prompt lines the operator attaches to models whose "provider/id" matches a pattern.
// Carl ships no rule and names no model; rules live in carl.json "modelGuidance": [{ "match": "<regex>", "text": "..." }].
// The lines are added per turn for the model the turn starts on: with fallbacks configured, sessions select the router
// ("carl/auto") and `resolve` names the chain link it would start on now (a benched primary's fallback included). A switch
// to a fallback in the middle of a turn keeps that turn's prompt; the next turn gets the new model's lines.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

export interface ModelGuidanceRule { match: string; text: string }

export function guidanceFor(model: { provider?: string; id?: string } | undefined, rules: readonly ModelGuidanceRule[]): string {
  if (!model?.id) return "";
  const ref = `${model.provider ?? ""}/${model.id}`;
  return rules.filter((r) => new RegExp(r.match, "i").test(ref)).map((r) => r.text).join("\n");
}

export function withGuidance(systemPrompt: string, model: { provider?: string; id?: string } | undefined, rules: readonly ModelGuidanceRule[]): string {
  const text = guidanceFor(model, rules);
  return !text || systemPrompt.includes(text) ? systemPrompt : `${systemPrompt}\n\n${text}`;
}

/** Section name the guidance renders under (<model_guidance>…</model_guidance>). */
export const GUIDANCE_SECTION = "model_guidance";

/**
 * Put the guidance into the prompt without replacing it: a named section, so other extensions' sections (MCP servers,
 * skills) stay. When an earlier handler already forced a whole prompt, sections no longer render, so the text is
 * appended to that forced prompt once instead.
 */
export function applyGuidance(event: any, text: string): { systemPrompt: string } | undefined {
  const options = event?.systemPromptOptions;
  if (!text) {
    if (options?.sections) delete options.sections[GUIDANCE_SECTION];
    return undefined;
  }
  if (options && options.forceSystemPrompt === undefined && options.sections) {
    options.sections[GUIDANCE_SECTION] = text;
    return undefined;
  }
  const current = String(event?.systemPrompt ?? "");
  return current.includes(text) ? undefined : { systemPrompt: `${current}\n\n${text}` };
}

type ModelRef = { provider?: string; id?: string } | undefined;

export function modelGuidance(rules: readonly ModelGuidanceRule[], resolve: (model: ModelRef) => ModelRef = (m) => m): InlineExtension {
  return {
    name: "carl-model-guidance",
    factory: (pi: ExtensionAPI) => {
      if (!rules.length) return;
      pi.on("before_agent_start", (event: any, ctx: any) => applyGuidance(event, guidanceFor(resolve(ctx?.model), rules)));
    },
  } as InlineExtension;
}
