# Changelog

Releases are tagged `v<version>`; each entry says what changed for an operator.

## 0.9.0

- **Post primitive.** `carl post dry-run | approve | now | schedule | clear-pending | record-live | status` publishes a post or thread from a Markdown draft, through one adapter contract per platform (`src/post/types.ts`, `src/post/registry.ts`). X is the first adapter, driven through an owned `overseer-browser` session. Accounts live only in `carl.json` (`post.accounts`); shipped code names none. See `docs/POSTING.md`.
- **Posting is off by default** and stays off while it could be walked around: with `post.accounts` set, every `guard.allowTools` and `guard.operatorTools` entry must match only tools that are verifiably read-only (the built-in read list, or a trusted server's `readOnlyHint: true`), and an entry that could match a future tool name (`.*`, `^overseer/coordinator_.*`) or any terminal-typing or worker-starting tool keeps posting off. A work queue whose jobs may run unsandboxed does too. `carl post status` says exactly why.
- **Your approval, on your channel.** `approve`, `clear-pending` and `record-live` only create a card in the Telegram home chat showing the exact parts, account, profile and text hash; the action runs only when a user in `telegram.allowFrom` presses Allow on that card. The approval is a keyed MAC over the text, account, profile and draft path, separate from the dry-run hash, so an edited, moved or copied draft needs fresh approval. The agent can ask for a card, never answer one.
- **Never two posts.** A write-ahead record (draft plus a state ledger, fsynced) is written before every click; any failure after a click is final and never retried; a rerun only looks for the pending part and records it when found. Before clicking, text already live after approval is refused. A post counts only when its whole text matches and X created it after approval and after the previous part.
- **Durable scheduling.** A one-time `post` schedule job fires at its slot and skips a slot missed by more than `post.missedWindowMinutes` (180), saying so. The agent may give an approved draft its first slot only at least 15 minutes out, and only if you are told; it cannot run, resume, remove or pause a post job.
- **Sandbox.** With posting configured, the agent's shell cannot reach the browser relay's socket, its runtime folders, the approval key or the local debug port.
- **Unattended reads.** The built-in read-only list matches the current `coordinator_` tool names, so unattended runs are no longer refused `coordinator_job_list` and similar reads.
