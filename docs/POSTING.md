# Posting

Carl can publish a social post from a draft file, now or at a time you choose. It never posts anything you have not
approved, and it never posts the same text twice. X is the first platform; another platform is one new file.

## How it works

A post moves through the same steps on every platform:

1. **Draft.** A Markdown file with a few settings at the top (the front matter) and the text.
2. **Dry run.** Carl renders the text, checks it (length, empty parts, a known account) and, for X, fills the real
   composer and reads it back to prove it holds exactly your text, then throws it away. Nothing is posted. A dry run
   needs no approval.
3. **Approval.** You read the exact text and approve it. The approval is tied to that text.
4. **Post.** Carl posts it, now or at the scheduled time.
5. **Verify.** Carl finds the live post on the account's profile and takes its URL from there.
6. **Record.** The draft is updated with `status: Posted`, `posted_at`, `post_url` and `thread_urls`.

## A draft

```markdown
---
platform: x
account: main
status: Draft
text: "One claim, one link."
reply: "The details are in the repo: https://example.org/repo"
---
```

- `platform` and `account` are required. `account` is a key from your configuration (below), never a login or a URL.
- `text` is one post. `reply` (or `first_reply`) is an optional reply under it.
- For a thread, use `thread:` with a list of parts instead of `text`. The first part is a post and each later part
  replies to the one before.
- The text can also sit in the body under `## Post`, `## First reply` and `## Thread` (parts under `### 1`, `### 2`),
  which is how a notes vault usually stores it.
- Carl writes `status`, `approved`, `approved_hash`, `scheduled_at`, `posted_at`, `post_url`, `reply_url`,
  `thread_urls`, `schedule_note` and `last_error` back into the same file. It changes only those lines.

Writes are compare-and-set. If you have retex installed, Carl uses `retex set --if-hash`;
otherwise it writes a temporary file and checks the draft is unchanged before replacing it. If you edit the draft at
the same moment, Carl stops with an error instead of overwriting your edit.

## Configuration

Accounts live only in `~/.carl/carl.json`:

```json
{
  "post": {
    "draftsDir": "~/.carl/posts",
    "missedWindowMinutes": 180,
    "retex": "auto",
    "accounts": {
      "main": {
        "platform": "x",
        "profile": "https://x.com/example",
        "session": { "command": "overseer-browser", "timeoutSeconds": 60, "namePrefix": "carl-post" }
      }
    }
  }
}
```

- `draftsDir` is where `carl post` and the agent's tool look for drafts. Keep it where the agent cannot write (the
  default, inside `~/.carl`, is read-only to the sandboxed agent), because the approval lives in the draft.
- `missedWindowMinutes` is the lateness a scheduled slot tolerates (default 180).
- `retex` is `"auto"` or `"off"`.
- `session` says how to drive the browser. X is posted through an owned `overseer-browser` session in your own browser,
  so you must be signed in to the account there. Carl passes `--timeout` explicitly, because the default is too short
  for X.

## Commands

```
carl post dry-run <draft> [--offline]
carl post approve <draft> [--by <name>]
carl post now <draft>
carl post schedule <draft> --at <ISO time> [--late post]
carl post status
```

`<draft>` is a name in `draftsDir` (`launch-note`) or a path.

## Approval

Carl refuses to post, now or scheduled, unless the draft carries an approval from you for its current text:

- `approved:` is a non-empty value that names who and when (`alice 2026-03-10T12:00:00.000Z`);
- `approved_hash:` matches the draft's text. The hash covers the platform, the account, the text, the thread parts and
  the reply. Edit any of them and the old approval no longer applies: approve again.

`carl post approve` shows you the exact text and asks. It needs a terminal, so a script or an agent cannot run it for
you. The agent's tool can draft, dry-run and schedule, but has no way to approve or to post at once. Scheduling checks
the approval when you schedule and again when the slot fires, so a draft edited in between is refused, not posted.

## Scheduling

X's own scheduling is a paid feature, so Carl keeps the schedule. `carl post schedule` adds a one-time job to
`schedules.json` and marks the draft `Scheduled`. The job survives restarts. If the gateway is running it picks the job
up within about 20 seconds; if not, the job waits for the next start.

**Missed slots.** If Carl was down or busy and the slot is more than the window late (3 hours by default), the post is
skipped: the draft stays `Scheduled`, a `schedule_note` records why, and the message Carl delivers says plainly that it
was not posted. Nothing is posted by surprise hours later. Reschedule it, or post it with `carl post now`. With
`--late post` (or `late: "post"` in the tool) a missed slot is posted late instead, and the message says how late.

**Failures and resume.** If a run fails (the browser timed out, X was slow), the job is retried a minute later, up to
five times. Before each part of a thread Carl looks on the profile for it, so a part that went live before the run died
is recorded, not posted again. A thread that is partly live is finished even if the slot is long past, because leaving
it half posted is worse. A refusal (no approval, an edited draft) is final and is not retried.

You can also rerun `carl post now <draft>` yourself at any point; it resumes the same way.

## Limits to know

- X counts every link as 23 characters; a post or thread part over 280 is refused before anything is sent.
- Media is not attached. Attach it yourself or post text only.
- If a part goes live but Carl cannot find it on the profile to record its URL, the run stops with an error telling you
  to check the profile. A rerun looks there first and does not repost.
- One run per draft at a time (a lock in `~/.carl/state/post-locks`).

## Adding a platform

A platform is one file in `src/post/adapters/` that implements `PostAdapter` (`src/post/types.ts`): `render` (pure
validation), `dryRun`, and `post` (resumable, verifies the live URL, reports each part as it lands). Register it in
`src/post/registry.ts`. Everything else, including approval, scheduling and recording, is shared.
