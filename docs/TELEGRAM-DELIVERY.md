# Telegram delivery and audit safety

Carl 0.4.2 never automatically repeats an ambiguous Telegram mutation. A lost network response, malformed response or
HTTP 5xx may mean Telegram accepted the message; it is not evidence of refusal. This applies to sends, uploads,
copies, forwards, edits and deletions. Read-only calls retain bounded retries. Explicit Bot API 429 refusals retain
bounded retries and honor `retry_after`; a delay above 60 seconds is returned to the caller rather than retried early.
HTML-to-plain-text fallback runs only after an explicit HTTP/Bot API 400 refusal, not a timeout or server error.

The gateway outbox keeps uncertain replies with `status: "unknown"` and the request identity. Restarting Carl or
flushing the outbox does not resend them or expire them after 24 hours. Carl attempts one in-chat notice per held
outcome (the attempt is persisted first, so a lost notice response is not replayed after restart); `/status` shows the
held count and IDs for the current chat/topic, and `/outbox` lists them. Check the actual chat before using
`/outbox resend <id>`: this explicitly authorizes replay and may duplicate an already-delivered reply. It resets
both the retry age and attempt count before sending, giving even an older held reply a fresh 24-hour retry window.
The result distinguishes delivered, queued, held-again and dropped replies; a drop is never reported as resent.
`/outbox discard <id>` removes the held reply without sending it; neither command can resolve another chat/topic's
reply. Carl does not automatically reconcile or authorize replay.

Streaming, when explicitly enabled, stops after an uncertain **draft send** rather than posting another draft or
final message over an unknown outcome. A lost own-draft edit response does not hold the whole final reply: final
edits get one bounded retry, then durable outbox retries against that same draft message ID (never a fresh send).
An uncertain best-effort deletion of Carl's own silent draft does not prevent the separate final reply from sending.
Individual Bot API edit/delete receipts still accurately report unknown outcomes; only the safe own-draft recovery
path treats those operations as idempotent.

## UltraTerm receipts

When `ultraterm` is configured, Carl records message mutations in
`~/.ultraterm/logs/ultrabot-messages/hermes.jsonl`:

- Each completed call has a unique `requestId` and `status`: `delivered` (`ok: true`), `failed` (`ok: false`), or
  `unknown` (`ok: null`). Failed and unknown calls retain attempted wording and the redacted error reason. Missing
  chat/message identity is represented as null, never silently dropped or inferred from a copy's source message.
- Text, button labels, filenames, errors and provenance are masked before persistence: bot tokens (including
  `/bot<token>` URLs), `sk-`, GitHub and Slack credential families, Bearer tokens, Authorization/Proxy-Authorization
  credentials, secret environment assignments and quoted JSON secret fields (including escaped/unterminated values).
  Slack refresh tokens (`xoxe-`) are included. Numeric bot tokens and structurally recognizable vendor credentials
  are masked even when directly preceded by a letter or digit. Embedded vendor lookalikes need a known credential
  structure (for example a numeric Slack segment or the fixed GitHub token shape), so ordinary words and short
  prefixes remain intact. Masked receipts carry `masked: true`, `exact: false`.
- Omitted markup produces `buttons: null` (unchanged); an explicit empty keyboard produces `buttons: []` (removed).
- `carl send` preserves `ULTRABOT_LOG_SOURCE`, `ULTRABOT_LOG_KIND`, `ULTRABOT_LOG_JOB` and `ULTRABOT_LOG_ALERT` in the
  sole receipt, read once for that invocation only; the gateway ignores these environment values. Labels must start
  with an ASCII letter/digit, contain only ASCII letters/digits or `_.:-`, and be at most 128 characters. Kind must be
  a Bot API message method or a known UltraBot label (`question`, `done`, `done-incomplete`, `correction`, `failed`,
  `waiting`, `blocked`, `priority-fix`, `unowned`, `stalled`, `routine-digest`, `digest`). Invalid fields are ignored
  individually with a diagnostic that never echoes their values. Empty job/alert fields become null. Without an
  origin envelope the source is `telegram`, the kind is the Bot API method and job/alert are null.
- Files are owner-only regular files with a single link. Directory symlinks, file symlinks, FIFOs and devices are
  refused, including lock, loss-counter and rotation paths. Descriptor-based, no-follow, nonblocking opens prevent
  planted FIFOs from hanging a send; chmod, rollback and append operate on validated descriptors.
- The log directory and its immediate parent must be owned. The immediate parent must not be group/world-writable
  (mode & 0022), matching UltraTerm's shared logs directory, which may be 0755. It is never chmodded by Carl.
  The private receipt directory is tightened to 0700; an unsafe immediate parent is refused with a reason.
  More distant user-owned ancestors (for example a 0775 home) are allowed without chmod; directory symlink and
  unowned writable ancestor guards remain.
- Locks record the process birth identity as well as PID. A stale lock is reclaimed if its process exited or the
  PID now belongs to a different process; unavailable identity checks conservatively retain a live lock. Older
  lock formats are reclaimed for PID reuse only when the current process was born after the recorded acquisition.
  Reclaimed writer locks leave conservative loss evidence, and already-counted skipped receipts remain counted.
- Rotation retains five 10 MiB segments. Appends are synced before acknowledging pending loss counters. Interrupted
  tails are repaired within a 64 KiB bound without discarding complete receipts; fragment recovery is marked with
  `recoveredFragments`. Writer contention skips the receipt instead of blocking delivery; durable private loss
  counters (`hermes.writeerrors`, using the existing audit reader's count/fragment schema) are carried into the next
  successful row as `writeErrors`. A failed or contended counter uses private fallback counters and leaves
  `hermes.writeerrors.pending` with a conservative fragment marker; this remains incomplete until reconciled, rather
  than risking a false completeness claim. Counter read problems are marked with
  `errorCounterUnacknowledged` and never suppress an otherwise-writable receipt.

Logging is best effort and never changes a send result. A completely unwritable or unsafe log directory can prevent
both the receipt and its durable loss counter; Carl warns once and retains an in-process count for the next successful
receipt. Absence of a loss marker is not proof that every process survived long enough to record its attempt.
`CARL_MESSAGE_LOG_DIR` redirects the destination for isolated testing; it does not enable UltraTerm logging on a plain
Carl installation. These receipts are local Bot API evidence, not screenshots or independent delivery confirmation.

## UltraTerm decision buttons

The trusted `ut-overseer decision-answer` child inherits the gateway's environment, including whatever verified
UltraBot identity its UltraTerm launcher supplies. Carl does not strip that identity through the agent-command
sandbox environment, generate authority credentials, or bypass UltraTerm's decision/approval checks. If the launcher
did not supply the required authority, the child may refuse the answer and Carl reports that refusal. Group-chat
and malformed-button guards still apply before the child is launched; Telegram's user allowlist applies before the
callback handler is invoked. Identity values must not be logged or copied into agent-command environments.
