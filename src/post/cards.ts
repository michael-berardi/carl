// Operator cards. Approving a draft, clearing a pending click and recording a post as live change what Carl will post, so none of
// them can be done by whoever can run a command or type into a terminal. A request (the CLI, the agent's tool) only writes a card
// file; the gateway shows the card on the operator's channel with the exact text, account, profile URL and text hash, and the
// action is carried out only when the operator answers that card there. The answer arrives as a channel callback in the gateway's
// memory, bound to the keyed hash of what was shown; nothing on disk can make a card "approved".
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { PostService } from "./service.ts";
import { permanentSendFailure } from "../channels/telegram.ts";

export type CardKind = "approve" | "clear-pending" | "record-live";

export interface CardRequest {
  id: string;
  kind: CardKind;
  /** Absolute path of the draft. */
  draft: string;
  /** record-live: the URL of the post. */
  url?: string;
  /** Who asked (informational: it decides nothing). */
  by: "operator" | "agent";
  at: string;
}

const KINDS = new Set<string>(["approve", "clear-pending", "record-live"]);
const MAX_PENDING = 8;
const MAX_AGE_MS = 48 * 3600_000;
/** After the operator denies a card the agent asked for, the agent cannot ask for the same thing again for this long. */
export const DENY_COOLDOWN_MS = 6 * 3600_000;
const RETRY_AFTER_FAILED_SEND_MS = 60_000;

/** Card files under CARL_HOME/state/post-cards (closed to the agent's shell by the sandbox). */
export class CardStore {
  readonly dir: string;
  private readonly clock: () => number;
  constructor(home: string, clock: () => number = Date.now) {
    this.dir = join(home, "state", "post-cards");
    this.clock = clock;
  }

  list(now = this.clock()): CardRequest[] {
    if (!existsSync(this.dir)) return [];
    const out: CardRequest[] = [];
    for (const f of readdirSync(this.dir).filter((n) => /^[0-9a-f]{12}\.json$/.test(n))) {
      try {
        const c = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as CardRequest;
        const fresh = Date.parse(c.at) > now - MAX_AGE_MS;
        if (c.id === f.slice(0, -5) && KINDS.has(c.kind) && typeof c.draft === "string" && c.draft.startsWith("/") && (c.url === undefined || typeof c.url === "string") && fresh) out.push(c);
        else rmSync(join(this.dir, f), { force: true });
      } catch { /* unreadable: ignored */ }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** One card per (kind, draft, url): asking again returns the card already waiting. */
  add(card: CardRequest): { card: CardRequest; fresh: boolean } {
    if (card.by === "agent") {
      const denied = this.deniedAt(card);
      if (denied !== undefined && this.clock() - denied < DENY_COOLDOWN_MS) throw Object.assign(new Error(`the operator denied this request ${Math.ceil((this.clock() - denied) / 60_000)} minute(s) ago; it is not asked again for ${DENY_COOLDOWN_MS / 3600_000} hours. Tell the operator what you need instead`), { final: true });
    }
    const existing = this.list().find((c) => c.kind === card.kind && c.draft === card.draft && c.url === card.url);
    if (existing) return { card: existing, fresh: false };
    if (this.list().length >= MAX_PENDING) throw Object.assign(new Error(`${MAX_PENDING} cards already wait for the operator; answer them first`), { final: true });
    const made = { ...card, id: randomBytes(6).toString("hex") };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${made.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(made, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return { card: made, fresh: true };
  }

  private denyFile(card: { kind: string; draft: string; url?: string }) {
    return join(this.dir, `deny-${createHash("sha256").update(JSON.stringify([card.kind, card.draft, card.url ?? null])).digest("hex").slice(0, 16)}.json`);
  }
  /** Remember that the operator said no to this request (kind, draft, url). */
  deny(card: CardRequest): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.denyFile(card), JSON.stringify({ at: this.clock() }) + "\n", { mode: 0o600 });
  }
  private deniedAt(card: { kind: string; draft: string; url?: string }): number | undefined {
    try { const at = JSON.parse(readFileSync(this.denyFile(card), "utf8"))?.at; return typeof at === "number" ? at : undefined; } catch { return undefined; }
  }

  remove(id: string): void {
    if (/^[0-9a-f]{12}$/.test(id)) rmSync(join(this.dir, `${id}.json`), { force: true });
  }
}

export type Decision = { answer: "approved" | "denied" | "timeout"; by?: string };
/** Shows `text` to the operator on their channel and waits for their answer; undefined = no operator channel is available (the card stays). */
export type Decide = (text: string, card: CardRequest) => Promise<Decision> | undefined;

/** The gateway's loop: show each waiting card once, apply it on an operator yes, tell the operator what happened. */
export class CardDesk {
  private readonly shown = new Set<string>();
  /** A card whose message could not be sent is tried again after this time. */
  private readonly retryAt = new Map<string, number>();
  private readonly svc: PostService;
  private readonly store: CardStore;
  private readonly decide: Decide;
  private readonly tell: (message: string) => void;
  constructor(svc: PostService, decide: Decide, tell: (message: string) => void) {
    this.svc = svc;
    this.store = new CardStore(svc.deps.home, () => (svc.deps.now ?? Date.now)());
    this.decide = decide;
    this.tell = tell;
  }

  /** Serve every card not yet shown by this process. Resolves when they are all answered. */
  async pump(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const card of this.store.list()) {
      if (this.shown.has(card.id)) continue;
      if ((this.retryAt.get(card.id) ?? 0) > (this.svc.deps.now ?? Date.now)()) continue;
      let described: { text: string; bind: string };
      try { described = this.svc.describeCard(card); } catch (e) {
        this.store.remove(card.id);
        this.tell(`Card ${card.kind} ${card.draft.split("/").pop()} was dropped: ${(e as Error).message}`);
        continue;
      }
      const asked = this.decide(described.text, card);
      if (!asked) continue; // no operator channel yet: it stays and is shown when there is
      this.shown.add(card.id);
      work.push(asked.then(async (d) => {
        this.store.remove(card.id);
        if (d.answer === "denied" && card.by === "agent") this.store.deny(card);
        if (d.answer !== "approved") return;
        try { this.tell(await this.svc.applyCard(card, described.bind, `operator ${d.by ?? "channel"}`)); } catch (e) { this.tell(`Not done (${card.kind} ${card.draft.split("/").pop()}): ${(e as Error).message}`); }
      }).catch((e) => {
        if (permanentSendFailure(e)) {
          // No retry can fix this (blocked bot, chat gone): stop, and say so once.
          this.store.remove(card.id);
          this.tell(`Card ${card.kind} ${card.draft.split("/").pop()} could not be delivered and will not be retried: ${(e as Error).message}. Nothing was done; ask again after fixing the home chat.`);
          return;
        }
        // The card could not be put in front of the operator: it is shown again later (not stranded until a restart).
        this.shown.delete(card.id);
        this.retryAt.set(card.id, (this.svc.deps.now ?? Date.now)() + RETRY_AFTER_FAILED_SEND_MS);
        this.tell(`Card ${card.id} could not be shown (${(e as Error).message}); trying again in a minute`);
      }));
    }
    await Promise.all(work);
  }
}
