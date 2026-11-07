# Posting

Carl can publish a social post from a draft file, now or at a time you choose. It never posts anything you have not
approved. It is built so that Carl never clicks Post twice for the same part: a click is recorded before it happens, and
anything that goes wrong after it stops for you to check instead of retrying. X is the first platform; another platform
is one new file.

## How it works

A post moves through the same steps on every platform:

1. **Draft.** A Markdown file with a few settings at the top (the front matter) and the text.
2. **Dry run.** Carl renders the text, checks it (length, empty parts, a known account, no control characters) and,
   for X, checks the browser is signed in to the configured account, fills the real composer and reads it back to prove
   it holds exactly your text, then throws it away. Nothing is posted. A dry run needs no approval. A live dry run
   (without `--offline`) records `dry_run_hash`; posting and scheduling require it for the exact text, unless you pass
   `--skip-dry-run`.
3. **Approval.** You read the exact text and approve it. The approval is tied to that text, to the account key and to
   the account's profile URL, and is signed with a key only Carl holds (below).
4. **Post.** Carl posts it, now or at the scheduled time. Before each click it writes `pending_part` into the draft; if
   that write fails, nothing is clicked.
5. **Verify.** Carl finds the live post on the account's profile and takes its URL from there. The post must have the
   whole text (not a prefix), be created no earlier than your approval, have an id newer than anything on the profile
   before the click and newer than the previous part, and not be a URL already recorded.
6. **Record.** The draft is updated with `status: Posted`, `posted_at`, `post_url`, `thread_urls` and `part_hashes`,
   and `pending_part` is cleared.

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
- Carl writes `status`, `approved`, `approved_hash`, `dry_run_hash`, `scheduled_at`, `pending_part`, `pending_at`,
  `posted_at`, `post_url`, `reply_url`, `thread_urls`, `part_hashes`, `schedule_note` and `last_error` back into the
  same file. It changes only those lines.
- Not supported, and refused instead of silently dropped: `media:` and a `reply` on a thread. Control characters
  (including tabs, carriage returns and bidirectional controls) are refused in the text.
- Only `thread`, `thread_urls` and `media` are read as `[a, b]` lists; `text: [beta] note [x]` is plain text.

Writes are compare-and-set against the file as it was read. If you have retex installed, Carl uses
`retex set --if-hash` (a write that clears keys is one atomic write instead); a retex that is present but fails is an
error, not a silent fallback. Otherwise it writes a temporary file, checks the draft is unchanged and renames it. If you
edit the draft at the same moment, Carl stops with an error instead of overwriting your edit. (With retex the check
is the file hash a moment before retex's own; that window is small but not zero.)

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

- `draftsDir` is where `carl post` and the agent's tool look for drafts. It must be where the agent cannot write (the
  default, inside `~/.carl`, is read-only to the sandboxed agent), because the approval lives in the draft. Carl refuses to
  start with a `draftsDir` in the workspace, memory, media, spill or an `agentWritable` folder, and refuses a draft in
  one of them at fire time.
- `missedWindowMinutes` is the lateness a scheduled slot tolerates (default 180).
- `retex` is `"auto"` or `"off"`.
- `session` says how to drive the browser. X is posted through an owned `overseer-browser` session in your own browser,
  so you must be signed in to the account there; Carl checks the profile link in the left menu against the configured
  handle before it fills anything, and refuses (final) if it differs. The profile must be an `https://x.com/<handle>`
  (or `twitter.com`) URL. Carl passes `--timeout` explicitly, because the default is too short for X. The gateway runs
  with a private PATH, so at start Carl resolves `session.command` from your PATH and pins it like its other
  programs; `ENOENT` for the browser CLI at fire time would mean it was not on your PATH when Carl started.
- Child processes (the browser CLI, retex) get a scrubbed environment: no Carl keys or tokens.

## Commands

```
carl post dry-run <draft> [--offline]
carl post approve <draft> [--by <name>]
carl post now <draft> [--skip-dry-run]
carl post schedule <draft> --at <ISO time> [--late post] [--skip-dry-run]
carl post clear-pending <draft>
carl post status
```

`<draft>` is a name in `draftsDir` (`launch-note`) or a path.

## Approval

Carl refuses to post, now or scheduled, unless the draft carries an approval from you for its current text:

- `approved:` is a non-empty value that names who and when (`alice 2026-03-10T12:00:00.000Z`);
- `approved_hash:` is an HMAC-SHA256 of the platform, the account key, the account's profile URL, the text, the thread
  parts and the reply. The key is `~/.carl/post-approval.key` (0600), created by the gateway (or the first `carl post`)
  and never overwritten. Without it nobody can produce a valid approval, so a script that can write the draft file
  cannot forge one. Delete the key and every approval is void. Edit any covered field, or remap the account key to
  another profile, and the old approval no longer applies: approve again.

`carl post approve` shows you the exact text, marks the parts that are already live, and asks. The hash of what it
showed is passed to the approval, so a draft edited while the prompt was open is refused, not approved unseen. It needs
a terminal, so a script or an agent cannot run it for you. A part that is already live cannot be edited and re-approved.

Scheduling checks the approval when you schedule and again when the slot fires, so a draft edited in between is
refused, not posted.

### What the agent can and cannot do

The agent's `post_draft` tool can draft, dry-run and give an approved draft its **first** slot. It cannot approve,
post at once, change or replace a slot, choose `late`, or run or resume a scheduled post (the `schedule` tool refuses
`run` and `resume` for post jobs). A scheduled post fires at its slot; before the slot the runner refuses unless the
operator forces it (the portal's run button).

### Keeping the approval out of the agent's reach

The agent's shell runs in a Seatbelt sandbox. Whenever `post.accounts` is configured the profile also denies:

- reads of, writes to, and unix-socket connections into `~/Library/Application Support/OverSeer/browser/` (the browser
  control token, socket and CLI runtime), and `overseer-browser` is a hardline refusal in the shell guard. Without this a
  sandboxed command could drive your signed-in browser and post straight past the gate. Posting runs from the gateway,
  which is not sandboxed. If the agent needs a browser it uses its own session through the trusted OverSeer MCP server
  (the `overseer` entry in `trustedMcp`), which is unaffected.
- reads and writes of `~/.carl/post-approval.key`.

Two things in `carl.json` can still hand the agent your terminal or your approval, and Carl cannot close them for you:
`guard.allowTools` entries that let the agent run `overseer_send` (types into a real terminal, defeating the "needs a
terminal" check) or `overseer_job_add` (starts a job outside the sandbox). Remove both from `allowTools` so they ask
you first. The sandbox is also not verified against a live OverSeer here: whether `overseer-browser` is refused under
`sandbox-exec` is worth running once yourself.

## Scheduling

X's own scheduling is a paid feature, so Carl keeps the schedule. `carl post schedule` adds a one-time job to
`schedules.json` and marks the draft `Scheduled`. The job survives restarts. If the gateway is running it picks the job
up within about 20 seconds; if not, the job waits for the next start.

**Missed slots.** If Carl was down or busy and the slot is more than the window late (3 hours by default), the post is
skipped: the draft stays `Scheduled`, a `schedule_note` records why, and the message Carl delivers says plainly that it
was not posted. Nothing is posted by surprise hours later. Reschedule it, or post it with `carl post now`. With
`--late post` (or `late: "post"` in the tool) a missed slot is posted late instead, and the message says how late.

**Failures and resume.** A failure *before* the click (the browser timed out, X was slow, the page would not load) is
retried a minute later, up to five times, and nothing has been posted. A failure *after* the click is final and is never
retried: the part may be live. The draft keeps `pending_part`, the message says to check the profile, and a rerun only
looks for that part on the profile (the whole text, fresh, newer than the previous part); if it finds it, it records it
and goes on. If it does not find it, it refuses until you open the profile, confirm the part is not live, and run
`carl post clear-pending <draft>` (terminal only). A thread that is partly live, or has a pending click, is never skipped
for lateness: a skip says "NOT posted" only when no click was ever started. A refusal (no approval, an edited draft, the
wrong signed-in account) is final too.

A draft whose every part is recorded live but was never marked Posted (a crash in between) is just marked Posted the
next time it runs.

You can also rerun `carl post now <draft>` yourself at any point; it resumes the same way.

## Limits to know

- X counts every link as 23 characters; a post or thread part over 280 is refused before anything is sent.
- Media is not attached. Attach it yourself or post text only.
- If a part goes live but Carl cannot find it on the profile to record its URL, the run stops with an error telling you
  to check the profile (see Failures above). It never reposts on its own. A part whose text X renders differently from
  how Carl normalises it (unusual link punctuation, for example) fails safe the same way. Emoji are read from the page's
  `<img alt>`.
- X's length counts CJK and emoji as 2 (links 23); a part over 280 on that count is refused before anything is sent.
- The Post click re-reads the composer and refuses if it no longer holds exactly the text.
- If X refuses a repeat ("you already said that"), the old identical post is not accepted as this one (it is older
  than your approval or than the profile before the click); the run stops for you to check.
- One run per draft at a time (a lock in `~/.carl/state/post-locks`, keyed by the real path; a stale lock is taken over
  atomically). `schedules.json` is locked while the CLI or the gateway writes it, and a job removed by the CLI is dropped
  by a running gateway before it can fire.
- Not tested against live X: the page selectors and the emoji/duplicate behaviour come from X's page structure and have
  not been run against it here.

## Adding a platform

A platform is one file in `src/post/adapters/` that implements `PostAdapter` (`src/post/types.ts`): `render` (pure
validation), `dryRun`, and `post` (resumable, verifies the live URL, reports each part as it lands). Register it in
`src/post/registry.ts`. Everything else, including approval, scheduling and recording, is shared.
