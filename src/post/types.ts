// The post primitive's shared types. One adapter contract per platform: draft record -> render and validate (no side
// effects) -> dry run -> post -> verify the live URL -> record the outcome. Adding a platform is one new file in adapters/.

/** A command runner: tests pass a fake, the gateway passes the real one. Never throws for a non-zero exit. */
export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

/** An operator-configured account (carl.json `post.accounts.<key>`). Drafts name only the key. */
export interface PostAccount {
  platform: string;
  /** The account's profile URL; the adapter finds live posts there. */
  profile: string;
  /** How the adapter drives its browser session. */
  session: { command: string; timeoutSeconds: number; namePrefix: string };
}

/** What a draft says, platform-neutral. `parts` is the thread (or the one post); `reply` is the optional first reply. */
export interface DraftContent {
  platform: string;
  account: string;
  parts: string[];
  isThread: boolean;
  reply?: string;
}

/** A draft rendered for a platform: what will be sent, in order, and any problems found. */
export interface Rendered {
  /** Texts in posting order: a thread's parts, or the post followed by its first reply. Each after the first replies to the one before. */
  sequence: string[];
  /** Per-text size on the platform's own count. */
  sizes: number[];
  problems: string[];
}

export interface AdapterContext {
  account: PostAccount;
  run: Runner;
  sleep: (ms: number) => Promise<void>;
  /** A fresh id for session names. */
  id: () => string;
}

export interface DryRunReport { ok: boolean; lines: string[] }

export interface PostAdapter {
  readonly platform: string;
  /** Pure: render the draft for this platform and list every problem (length, empty parts, bad account). No side effects. */
  render(content: DraftContent, account: PostAccount): Rendered;
  /** Prove the platform would take exactly this text, then discard it. Posts nothing. */
  dryRun(ctx: AdapterContext, rendered: Rendered): Promise<DryRunReport>;
  /**
   * Post `rendered.sequence` starting after the `run.done` live URLs. Before every click `run.onBeforeClick` writes a
   * record that a click is under way; any failure after the click is a final PostError (the operator checks the account,
   * nothing is retried). A part with a pending click is only looked for, never clicked again. Returns every live URL.
   */
  post(ctx: AdapterContext, rendered: Rendered, run: PostRun): Promise<string[]>;
}

/** What the adapter needs from the caller to post safely. */
export interface PostRun {
  /** URLs of the parts already live, in order. */
  done: string[];
  /** When the operator approved (ms): nothing older can be this post. */
  approvedAtMs: number;
  /** A click was started on this part and never recorded: it may be live. Only a look at the profile may continue. */
  pending?: { part: number; atMs: number };
  /** Called, and awaited, before every click. If it throws, nothing is clicked. */
  onBeforeClick(part: number): Promise<void>;
  /** Called after each part is verified live with every live URL so far. */
  onPart(urls: string[]): Promise<void>;
}

/** A failure with a cause the operator can act on. `final` = retrying cannot help (a refusal, not a transient fault). */
export class PostError extends Error {
  override name = "PostError";
  final: boolean;
  constructor(message: string, final = false) {
    super(message);
    this.final = final;
  }
}
