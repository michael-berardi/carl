# Posting

Carl can publish a social post from a draft file, now or at a time you choose. Carl's own code posts only text you
approved on your operator channel. The act of posting needs something only your live Telegram press produces, so the
guard holds even when other programs run as you (see "Requirements"). It does not stop a same-user program from driving
the browser relay directly, outside Carl: that is not a Carl post (see "What remains"). Carl does not click Post a second time for a part it recorded a click for: the
click is recorded before it happens, and anything that goes wrong after it stops for you to check instead of retrying.
The check that the text is not already on the profile before a click is a best-effort net (it depends on the page
drawing), not a guarantee. X is the first platform; another platform is one new file.

## How it works

A post moves through the same steps on every platform:

1. **Draft.** A Markdown file with a few settings at the top (the front matter) and the text.
2. **Dry run.** Carl renders the text, checks it (length, empty parts, a known account, no control characters) and,
   for X, checks the browser is signed in to the configured account, fills the real composer and reads it back to prove
   it holds exactly your text, then throws it away. Nothing is posted. A dry run needs no approval. A live dry run
   (without `--offline`) records `dry_run_hash`; posting and scheduling require it for the exact text, unless you pass
   `--skip-dry-run`.
3. **Approval.** A card with the exact text, the account, its profile URL and the text hash appears on your operator
   channel (Telegram); you answer it there. The approval is tied to that text, to the draft's path, to the account key and
   to the account's profile URL, and is signed with a key that exists only in the running gateway's memory (below).
4. **Post.** Carl posts it, now or at the scheduled time. Before each click it writes `pending_part` (with the newest
   status id on the profile) into the draft and into Carl's own ledger, fsynced; if either write fails, nothing is
   clicked. A part whose exact text is already on the profile (posted after the approval) is not clicked when the page shows it (a best-effort check, not a guarantee).
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
  `pending_baseline`, `posted_at`, `post_url`, `reply_url`, `thread_urls`, `part_hashes`, `schedule_note` and `last_error` back into the
  same file. It changes only those lines.
- Not supported, and refused instead of silently dropped: `media:`, and on a thread a `reply`, `first_reply`, a
  `## First reply` section, `text` or a `## Post` section. Characters a terminal or chat can hide or show differently
  are refused in the text: controls (tabs and carriage returns too), bidirectional controls, U+2028/U+2029, soft
  hyphen, zero-width space and non-joiner, U+2060-2064, the byte-order mark and tag characters. The zero-width joiner is
  allowed (emoji sequences need it).
- A link must be written with its scheme (`https://example.org/x`). A bare domain such as `example.org/x` becomes a
  link on X while the draft keeps it literal, so a live post could not be matched; it is refused at render.
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
        "session": { "command": "your-browser-session-tool", "timeoutSeconds": 60, "namePrefix": "carl-post" }
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
- `session` says how to drive the browser. `session.command` (required; Carl assumes no program) is the tool that drives an owned browser session in your own browser; X is posted through it,
  so you must be signed in to the account there; Carl checks the profile link in the left menu against the configured
  handle before it fills anything, and refuses (final) if it differs. If the page never draws that link (a slow load, or
  logged out) the run fails as retryable, not as a wrong account. The profile must be an `https://x.com/<handle>`
  (or `twitter.com`) URL. Carl passes `--timeout` explicitly, because the default is too short for X. The gateway runs
  with a private PATH, so at start Carl resolves `session.command` from your PATH and pins it like its other
  programs. `session.command` may be a name, `~/...` (expanded when the configuration loads) or an absolute path;
  **set an absolute path if the gateway's launcher has a PATH that lacks the tool's folder** (for example
  `~/.local/bin`). If a session command does not resolve (not found, or not an executable file), the gateway logs an
  error and sends a message to the home chat when it starts, and `carl post status` begins with a `SESSION COMMAND
  PROBLEM` line (the CLI checks the PATH it was started with). Nothing is posted from an account whose command does not
  resolve; the first fire would otherwise fail with exit 127 and, after five retries, disable the job.
- Child processes (the browser CLI, retex) get a scrubbed environment: no Carl keys or tokens.

## Commands

```
carl post dry-run <draft> [--offline]
carl post approve <draft>
carl post now <draft> [--skip-dry-run]
carl post schedule <draft> --at <ISO time> [--late post] [--skip-dry-run]
carl post clear-pending <draft>
carl post record-live <draft> <url>
carl post status
```

`approve`, `clear-pending` and `record-live` only **ask**: each writes a card (below) and prints that it is waiting.
Nothing changes until you answer the card on your operator channel.

`<draft>` is a name in `draftsDir` (`launch-note`) or a path.

## Approval

Carl refuses to post, now or scheduled, unless the draft carries an approval from you for its current text:

- `approved:` is a non-empty value that names who and when (`operator 123456789 2026-03-10T12:00:00.000Z`: the Telegram
  user id that pressed the button);
- `approved_hash:` is an HMAC-SHA256 with purpose `approve` over the platform, the draft's path, the account key, the account's profile URL,
  the text, the thread parts, the reply **and the `approved:` stamp itself**. The key lives only in the running gateway's
  memory: it is generated when the gateway starts and is never written to disk (no key file, nothing in `~/.carl`). So only
  the gateway can make or check an approval; a program that can write the draft cannot compute a valid `approved_hash`.
  `dry_run_hash` is the same kind of HMAC with purpose `dry-run`, so a dry run's hash is not an approval, and an approval
  cannot be made by copying it next to an invented stamp. Changing the stamp's name or time voids the approval, and so
  does moving or copying the draft to another path. Edit any covered field, or remap the account key to another profile,
  and the old approval no longer applies: approve again.
- **A gateway restart voids every approval and every dry-run record** (a fresh key per start). Approvals are short-lived on
  purpose: an approval is good for **24 hours** and for **one post attempt**. After a click was made under an approval, starting
  over (say after `clear-pending`) needs a new press; finishing the same thread (parts already live, or a click pending) does not.
  `carl post schedule` refuses a slot later than the approval's 24 hours. A scheduled slot posts from the approval the gateway
  holds, bound to the text hash, until the slot or those 24 hours.
- A fresh approval ends an earlier `--skip-dry-run` on that draft's scheduled job.
- A draft with a `pending_part` cannot be approved: settle the pending click first (`record-live` or `clear-pending`).

### Operator cards

A terminal proves nothing: anything that can type into one can type `y`. So every act of posting is decided only on your
operator channel, and carried out only by the gateway process:

- `carl post` is a **client of the running gateway**: it sends `POST /carl/post` to `127.0.0.1:<api.port>` with `CARL_API_KEY`
  and prints the answer. It never posts, approves or records anything by itself, and holds no key, so a worker or terminal
  that runs `carl post now` can only **request a card**. `dry-run`, `schedule` and `status` also run in the gateway (they need
  its key); `dry-run`, `schedule` and `status` need no card.
- `carl post now|approve|clear-pending|record-live <draft>` (or the agent's `request_approval` action) writes a small
  request file under `~/.carl/state/post-cards/` (closed to the agent's shell). It refuses at once what could never be
  approved (an invalid draft, a missing live dry run, a URL that is not this account's status). Asking twice for the same
  thing is one card; at most 8 wait at a time; a request older than 48 hours is dropped.
- The running gateway (it looks every 4 seconds) shows each card in your Telegram home chat (`telegram.homeChat`):
  for `now`, the exact rendered parts (invisible characters shown as `\uXXXX`, parts already live marked), the account, its profile
  URL and the text hash, headed `POST NOW`; `approve` is the same without posting; for `clear-pending` the pending part, its time and the profile; for
  `record-live` the part's text and the URL. Every card says who asked (`Asked by: THE AGENT (not you)` or `you`). A card
  is never collapsed and never cut: a long one is sent as several messages, the buttons on the last. Buttons: Allow / Deny.
- Only a press by a user in `telegram.allowFrom` answers it, as a callback inside the gateway. The gateway re-reads the
  draft and acts only if the keyed hash of what is on disk equals the one it showed. An edit while the card was open means
  nothing is done. `now` approves the exact text and posts it in the same step, inside the gateway, after that press.
  Deny, or six hours without an answer, drops the card and does nothing; after a Deny of a card the agent asked for, the
  agent cannot ask for the same thing again for six hours (you can still ask with `carl post`). A press counts only
  from the message the buttons are on. If the card could not be sent to Telegram it is tried again a minute later. A card
  file cannot be made "approved": the answer exists only in the gateway's memory.

Needs: the gateway running with its API enabled (`api.enabled`, the default) and `CARL_API_KEY` set where `carl post` can read it, Telegram enabled, and `telegram.homeChat` set. Without a home chat the gateway logs that
approval cards cannot be answered, and cards wait. Slack and Discord are not used for cards. There is no portal button.

### What the agent can and cannot do

### Requirements and what remains

Posting is on whenever `post.accounts` is configured; it does not depend on which tools `guard.allowTools`,
`guard.operatorTools` or a work queue let run unasked. What makes the act of posting need your press:

1. The approval key exists only in the gateway's memory (above); nothing on disk lets a process make an approval.
2. Every click (`now`, a scheduled fire, `clear-pending`, `record-live`) runs inside the gateway, after a fresh card press
   verified in that same process (a scheduled fire uses the press made earlier by `approve`, held until the slot or 24 h).
3. `carl post` only asks the gateway to raise a card. Even a program that is not sandboxed (a coordinator worker, a terminal)
   can run `carl post now` and get nothing but a card in your Telegram.
4. The agent's sandbox cannot reach the gateway's API port at all, and cannot read the browser relay (below).

**What remains.** A same-user process outside Carl's sandbox could in principle drive the browser relay directly (the
session command, its socket and token), or script your signed-in browser some other way, and post. That is not a Carl post
and Carl cannot prevent it: the X account's own session, and the relay's own controls, are the boundary. Carl also does
not defend against a same-user process that attaches to the gateway process itself.

`guard.readOnlyTools` (a list of `"server/tool"` names) and the tools whose MCP listing carried `readOnlyHint: true` run
without asking on a trusted server; Carl names no server or tool of its own. See the README.

The agent's `post_draft` tool can draft, dry-run, **request** an approval card, and give an approved draft its **first**
slot at least 15 minutes away. The operator gets a message in the home chat when it does; that message is sent straight to Telegram (not queued), and if it
cannot be delivered the slot is removed. It cannot approve, answer a card, post at once, change or replace a slot, choose `late`,
or run, resume, pause or remove a scheduled post (the `schedule` tool refuses all four for post jobs). A scheduled post
fires at its slot; run before its slot without force, the job does nothing and changes no state (no attempt is used).
Only the portal's operator route forces it. UltraTerm's Run button does not force, so it cannot fire a post early either.

### Keeping the browser relay out of the agent's reach

The agent's shell runs in a Seatbelt sandbox. Nothing here is assumed: you tell Carl where your browser relay keeps its
control files, in `post.browser` (all optional; empty means Carl closes nothing about the relay):

```json
"post": {
  "browser": {
    "controlDirs": ["~/Library/Application Support/<relay>/browser", "~/.config/<relay>"],
    "descriptors": ["~/.config/<relay>/active-connection.json"],
    "descriptorEnv": ["<RELAY>_CONNECTION"],
    "runtimeEnv": ["<RELAY>_RUNTIME"],
    "socketPattern": "<relay>[^/]*\\.sock$",
    "commandPattern": "<relay>"
  }
}
```

- `controlDirs`: folders (control socket, token, CLI runtime) the sandbox denies reads, writes and socket connections into.
- `descriptors`: JSON files that name an absolute `runtime_root`; the file's folder and that root are closed too. The
  environment variables named in `descriptorEnv` / `runtimeEnv` (read from Carl's own environment) are followed as well.
  These are read when Carl starts: if you select a different relay later, restart Carl; the gateway refuses to post or run
  a live dry run once a descriptor differs from what it read at start.
- `socketPattern`: a regex for the relay's control socket file name; any unix socket matching it is refused by name wherever it
  lives (the rule matches the name only, so a hard link under another name in a folder that is not closed would not be matched).
- `commandPattern`: a regex; a shell command matching it is a hardline refusal for the agent while posting is configured.
  Default: the names of the accounts' `session.command` programs.
- Always, while posting is configured: connections to loopback port 9222 (a browser debugging port) are denied. Other
  debugging ports are not closed.

Without this a sandboxed command could drive your signed-in browser and post straight past the gate. Posting runs from the
gateway, which is not sandboxed. The test suite runs a small socket client under the rendered profile with `sandbox-exec`
and asserts a configured relay socket is refused (macOS only; skipped elsewhere).

## Scheduling

X's own scheduling is a paid feature, so Carl keeps the schedule. `carl post schedule` adds a one-time job to
`schedules.json` and marks the draft `Scheduled`. The job survives restarts. If the gateway is running it picks the job
up within about 20 seconds; if not, the job waits for the next start.

**Missed slots.** If Carl was down or busy and the slot is more than the window late (3 hours by default), the post is
skipped: the draft stays `Scheduled`, a `schedule_note` records why, and the message Carl delivers says plainly that it
was not posted. Nothing is posted by surprise hours later. Reschedule it, or post it with `carl post now`. With
`--late post` (operator only; the agent's tool has no such option) a missed slot is posted late instead, and the message says how late.

**Failures and resume.** A failure *before* the click (the browser timed out, X was slow, the page would not load) is
retried a minute later, up to five times, and nothing has been posted. A failure *after* the click is final and is never
retried: the part may be live. The draft keeps `pending_part` (and Carl's ledger, `~/.carl/state/post-ledger.jsonl`,
keeps the same record, so a stale editor save of the draft cannot erase it), the message says to check the profile, and a
rerun only looks for that part on the profile (the whole text, newer than the profile's newest post at the click, and no
earlier than your approval minus two minutes of clock slack); if it finds it, it records it and goes on. If it does not
find it, it refuses until you open the profile and either `carl post record-live <draft> <url>` (the part is live: you
answer a card showing the URL; the URL must be this account's status, newer than the part before it) or, when the part is
certainly not live, `carl post clear-pending <draft>` (you answer a card). Clearing too early would let Carl click again;
the check for the exact text already on the profile before every click is the net under that. A thread that is partly live, or has a pending click, is never skipped
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
- Draft writes are fsynced (the file, then its folder), and clicks and live posts are also appended to the ledger and
  fsynced. If the draft loses its `pending_part`, its live URLs or its `Posted` status to a stale save, the ledger
  restores them on the next run instead of clicking again, provided the draft still carries the approval the post was
  made under; one view of the draft and the ledger is used everywhere (posting, cards, status, schedule). If the
  ledger says a part went live with text other than the draft's now, Carl refuses. The ledger is keyed by the draft's path
  and its first part, so a draft saved under the same name with identical text after its post was deleted is refused
  with a message (save it under a new name or change the text) instead of being marked Posted. A ledger that cannot be
  read stops posting. A write-ahead record that cannot be written appends a `cleared` event so no click is assumed; if that append also fails, a click event remains and `carl post clear-pending` recovers it.
  A live dry run takes the draft's lock, so it refuses while a post holds the lock.
- Before a click Carl looks for the exact text on the profile for up to ten seconds; a timeline that never drew is a
  retryable refusal. Only X's own "nothing here" state lets a click proceed on an empty profile.
- The freshness checks allow two minutes of difference between this machine's clock and X's.
- One run per draft at a time (a lock in `~/.carl/state/post-locks`, keyed by the real path; a lock is taken over,
  atomically, only when its owner process is dead, however old it is). `schedules.json` is locked while the CLI or the gateway writes it, and a job removed by the CLI is dropped
  by a running gateway before it can fire.
- Not tested against live X: the page selectors and the emoji/duplicate behaviour come from X's page structure and have
  not been run against it here.

## Adding a platform

A platform is one file in `src/post/adapters/` that implements `PostAdapter` (`src/post/types.ts`): `render` (pure
validation), `dryRun`, and `post` (resumable, verifies the live URL, reports each part as it lands). Register it in
`src/post/registry.ts`. Everything else, including approval, scheduling and recording, is shared.
