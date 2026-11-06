# Changelog

Releases are tagged `v<version>`; each entry says what changed for an operator.

## 0.9.0

- **Post primitive.** `carl post dry-run | approve | now | schedule | status` publishes a post from a Markdown draft (front matter: `platform`, `account`, `text` or `thread`, optional `reply`). One adapter contract per platform (`src/post/types.ts`, registry in `src/post/registry.ts`); X is the first adapter, driven through an owned `overseer-browser` session with an explicit `--timeout`, a read-back check that the composer holds exactly the draft text, and the live URL found on the profile.
- **Approval gate.** Posting, live or scheduled, refuses unless the draft carries `approved:` (who and when) and an `approved_hash` that matches its current text; an edited draft needs fresh approval. `carl post approve` needs a terminal; the agent's `post_draft` tool can draft, dry-run and schedule but cannot approve or post at once.
- **Durable scheduling.** A new `post` schedule job kind (one-time, in `schedules.json`) fires a draft at `scheduled_at`. A slot missed by more than `post.missedWindowMinutes` (default 180) is skipped and the delivered message says so; `--late post` posts it late. A failed run is retried and resumes from a profile check, so a part already live is never posted twice. A running gateway adopts jobs added by `carl post schedule`.
- **Config.** `post` in `carl.json`: `draftsDir`, `missedWindowMinutes`, `retex`, and `accounts` (the only place accounts are defined).
- Draft writes are compare-and-set: `retex set --if-hash` when retex is installed, otherwise an atomic write after a hash check.
- Docs: `docs/POSTING.md` and a README section.
