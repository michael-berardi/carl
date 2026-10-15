// Carl's psyche, after Jung: layers that are integrated, not hidden.
//
//   Self     psyche/self.md        stable values that hold in every situation; outranks the persona
//   Persona  psyche/persona.md     tone and manner (the mask the world sees)
//   Shadow   psyche/shadow.jsonl   what went wrong: tool failures, aborted runs, operator corrections,
//                                  and Carl's own admissions. Recorded openly, never suppressed.
//   Lessons  psyche/integrated.md  the shadow, integrated: short lessons the individuation pass distils
//   Mirror   psyche/decisions.jsonl the operator's decisions and outcomes, so reflection gets sharper over time
//
// Only Self, Persona and Lessons reach the system prompt. The raw shadow and decision ledgers stay on disk
// and are read on demand (by the individuation pass and the mirror), so the psyche costs few tokens per turn.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SELF = `# Self

These values hold in every situation. When the persona, a request or a habit conflicts with them, they win.

- Tell the truth, including unwelcome truth. Never flatter. Say plainly when the operator is wrong, and why.
- Claim only what was verified. Name what was not checked. "Done" means seen working.
- Own mistakes in the open. A failure that is hidden repeats.
- Finish the work you take on, or say exactly what blocks it.
- Keep the human accountable: inform the judgment, do not take it over on consequential or irreversible choices.
- Spend tokens and attention like they are scarce. Short answers, no filler.
`;

export const DEFAULT_PERSONA = `# Persona

You are Carl, an operator's agent for agentic work: you plan, delegate, run tools and report.
Write like a sharp colleague on chat: answer first, short sentences, no preamble, no sign-offs.
Use Markdown sparingly (it is rendered in Telegram). Prefer lists only for real lists.
`;

export type ShadowKind = "tool_error" | "run_failed" | "aborted" | "correction" | "admission";

export interface ShadowEntry {
  at: string;
  kind: ShadowKind;
  conversation: string;
  summary: string;
  evidence?: string;
}

export interface Decision {
  at: string;
  id: string;
  decision: string;
  rationale?: string;
  expected?: string;
  outcome?: string;
  outcomeAt?: string;
}

// Phrases that usually mean "you got that wrong". A heuristic; it only flags, the individuation pass judges.
const CORRECTION = /^(no\b|nope\b|wrong\b|that'?s (not|wrong)|not what i|i (said|asked|told you)|why (did|would) you|don'?t\b|do not\b|stop (doing|that)|you (forgot|missed|didn'?t|did not|ignored)|again\?|still (broken|wrong|not))/i;

export function looksLikeCorrection(text: string): boolean {
  return CORRECTION.test(text.trim());
}

export class Psyche {
  readonly dir: string;
  constructor(home: string) {
    this.dir = join(home, "psyche");
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  /** Create missing layer files with defaults; existing files are never overwritten. */
  seed(personaSource?: string): void {
    if (!existsSync(this.path("self.md"))) writeFileSync(this.path("self.md"), DEFAULT_SELF, { mode: 0o600 });
    if (!existsSync(this.path("persona.md"))) {
      const persona = personaSource && existsSync(personaSource) ? readFileSync(personaSource, "utf8") : DEFAULT_PERSONA;
      writeFileSync(this.path("persona.md"), persona, { mode: 0o600 });
    }
  }

  read(name: "self.md" | "persona.md" | "integrated.md"): string {
    const p = this.path(name);
    return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
  }

  /** The psyche's share of the system prompt: Self first (it outranks), then Persona, then integrated lessons. */
  promptSections(): string[] {
    const out: string[] = [];
    const self = this.read("self.md");
    if (self) out.push(self);
    const persona = this.read("persona.md");
    if (persona) out.push(persona);
    const lessons = this.read("integrated.md");
    if (lessons) out.push(`# Lessons from your own shadow\n\nDistilled from your past failures and corrections. Act on them.\n\n${lessons}`);
    return out;
  }

  recordShadow(entry: Omit<ShadowEntry, "at">): ShadowEntry {
    const full: ShadowEntry = {
      at: new Date().toISOString(),
      ...entry,
      summary: entry.summary.slice(0, 500),
      evidence: entry.evidence?.slice(0, 1_500),
    };
    appendFileSync(this.path("shadow.jsonl"), JSON.stringify(full) + "\n", { mode: 0o600 });
    return full;
  }

  shadowSince(sinceIso?: string, limit = 200): ShadowEntry[] {
    return readJsonl<ShadowEntry>(this.path("shadow.jsonl"))
      .filter((e) => !sinceIso || e.at > sinceIso)
      .slice(-limit);
  }

  recordDecision(d: Omit<Decision, "at" | "id">): Decision {
    const full: Decision = { at: new Date().toISOString(), id: `d-${Date.now().toString(36)}`, ...d };
    appendFileSync(this.path("decisions.jsonl"), JSON.stringify(full) + "\n", { mode: 0o600 });
    return full;
  }

  /** Attach an outcome to a decision; outcomes are appended as new rows and merged on read. */
  recordOutcome(id: string, outcome: string): Decision | undefined {
    const current = this.decisions().find((d) => d.id === id);
    if (!current) return undefined;
    const updated = { ...current, outcome, outcomeAt: new Date().toISOString() };
    appendFileSync(this.path("decisions.jsonl"), JSON.stringify(updated) + "\n", { mode: 0o600 });
    return updated;
  }

  decisions(limit = 100): Decision[] {
    const byId = new Map<string, Decision>();
    for (const d of readJsonl<Decision>(this.path("decisions.jsonl"))) byId.set(d.id, { ...byId.get(d.id), ...d });
    return [...byId.values()].slice(-limit);
  }

  lastIndividuation(): string | undefined {
    const p = this.path("integrated.md");
    return existsSync(p) ? statSync(p).mtime.toISOString() : undefined;
  }

  writeIntegrated(lessons: string): void {
    writeFileSync(this.path("integrated.md"), lessons.trim() + "\n", { mode: 0o600 });
  }
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line from a crash is skipped, not fatal.
    }
  }
  return out;
}

/** The individuation pass: Self against actual behavior. Returns the prompt for a fresh, tool-light session. */
export function individuationPrompt(self: string, lessons: string, shadow: ShadowEntry[], decisions: Decision[], behaviour: string): string {
  const shadowText = shadow.length
    ? shadow.map((e) => `- ${e.at.slice(0, 16)} [${e.kind}] ${e.summary}${e.evidence ? ` | ${e.evidence.replace(/\s+/g, " ").slice(0, 300)}` : ""}`).join("\n")
    : "(no new shadow entries)";
  const decisionText = decisions.length
    ? decisions.map((d) => `- ${d.at.slice(0, 10)} ${d.decision}${d.expected ? ` | expected: ${d.expected}` : ""}${d.outcome ? ` | outcome: ${d.outcome}` : ""}`).join("\n")
    : "(none recorded)";
  return `Individuation pass. Compare your stated values with what you actually did, and integrate what you find.

## Your Self (stated values)
${self}

## Current lessons (integrated.md)
${lessons || "(none yet)"}

## Shadow since the last pass
${shadowText}

## Operator decisions on record
${decisionText}

## Sample of your recent replies
${behaviour || "(none)"}

Reply with exactly these three Markdown sections and nothing else:

### Lessons
The new integrated.md: at most 12 bullets, each "When <situation>, I <failure pattern>; instead I <behaviour>." Keep lessons that still apply, merge duplicates, drop ones the evidence no longer supports. Only patterns with evidence above.

### Contradictions
Where behaviour contradicted a stated value, with the evidence line. "None found" if none.

### Proposals
Concrete procedure or configuration changes that would prevent repeats (max 5), or "None".`;
}

/** Split the individuation reply into its sections. */
export function parseIndividuation(reply: string): { lessons: string; contradictions: string; proposals: string } {
  const section = (name: string) => {
    const m = reply.match(new RegExp(`###\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|$)`, "i"));
    return m ? m[1].trim() : "";
  };
  return { lessons: section("Lessons"), contradictions: section("Contradictions"), proposals: section("Proposals") };
}

export const MIRROR_INSTRUCTION = `Mirror mode for this message. The operator wants reflection, not an answer.
- Hold up what they said against their recorded decisions and outcomes (use the decision_log tool with action "list").
- Name contradictions and avoided questions plainly. No flattery, no reassurance, no verdict on what they should do.
- End with the one question they most need to answer. The decision stays theirs.`;
