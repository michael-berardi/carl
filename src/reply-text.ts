/**
 * Reasoning-tag fragments that a model sometimes leaks into its visible reply, such as a stray
 * `</think:6124c78e>` after the answer. They are removed before any reply text is delivered.
 * Text inside fenced code blocks and inline code spans is left alone, so a reply that quotes the
 * tag literally still reads correctly. Provider-neutral: this knows only the tag shapes.
 */

// `<think>`, `</think>`, `<think:ID>`, `</think:ID>`, and the same with `thinking`.
const TAG = /<\/?think(?:ing)?(?::[A-Za-z0-9_-]+)?\s*>/gi;
// A complete reasoning block, `<think ...>...</think ...>`, removed with its contents.
const BLOCK = /<think(?:ing)?(?::[A-Za-z0-9_-]+)?\s*>[\s\S]*?<\/think(?:ing)?(?::[A-Za-z0-9_-]+)?\s*>/gi;
// Fenced code (``` or ~~~) and inline code spans: kept verbatim.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;

function stripOutsideCode(segment: string): string {
  return segment.replace(BLOCK, "").replace(TAG, "");
}

export function stripReasoningTags(text: string): string {
  if (!text || !/think/i.test(text)) return text;
  // Splitting with a capture group puts the code parts at odd indexes.
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : stripOutsideCode(part)))
    .join("");
}
