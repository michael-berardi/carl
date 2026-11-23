# Changelog

Releases are tagged `v<version>`; each entry says what changed for an operator.

## 0.18.9 (2026-11-23)

- **Failed scheduled posts still tell you.** 0.18.8 silenced every failed built-in schedule, which also hid a scheduled post that could not go out. Only housekeeping built-ins (Individuation, feedback) stay quiet now; a failed scheduled post reports its cause and its retry note again, as before 0.18.8.

## 0.18.8 (2026-11-23)

- **Housekeeping failures no longer page your chat.** A failed built-in schedule (Individuation, feedback) logs `schedule failed` with the cause and keeps `lastStatus`/`lastError` for `carl status`, `/schedules` and `carl doctor`, but delivers no failure message. Your own prompt and command schedules still report failures, and a built-in's successful output is unchanged. Live case: Individuation sent `Schedule "Individuation" failed: Claude Code is not logged in ...` into the home chat.
- **Provider login problems no longer become operator questions.** A run failure diagnosed as provider access (401/402/429, expired login or token, usage limit, unsupported model) is recorded as `provider_failed` in the shadow instead of `run_failed` and excluded from the individuation pass. The entries stay in the ledger for `/shadow` and UltraTerm; behavioural failures still reach individuation. Regression tests in `test/schedule-delivery.test.ts`, `test/provider-failure.test.ts` and `test/individuation-adopt.test.ts`.

## 0.18.7 (2026-11-23)

- **Gateway auto-update now actually fires.** The gateway's daily check was scheduled from the shared `checkedAt` timestamp, which CLI checks such as `carl update --check` and every gateway restart also refreshed; frequent checks postponed the tick indefinitely, so `update.auto` never installed anything. The gateway now keeps its own persisted next-check deadline that only it moves, and an auto-install decision no longer depends on a stale `notified` marker, so a failed attempt is retried. While runs are active the install is skipped with a named `runs active` log cause and retried in ten minutes; the existing restart-when-idle behaviour is unchanged. Regression tests in `test/auto-update.test.ts`.

## 0.18.6 (2026-11-22)

- `carl doctor` now forces a Codex credential refresh even while the saved access token still looks valid, so a rotated-away refresh token is reported instead of looking signed in.
- The outbox expiry pass keeps its in-memory queue in sync with the saved file when another gateway removes the same held reply first.

## 0.18.5 (2026-11-22)

- The remaining credential-shaped test fixture now uses a clearly non-credential placeholder. No runtime behavior changed from 0.18.4.

## 0.18.4 (2026-11-22)

- A synthetic credential-shaped string in the test suite no longer trips the release secret scan. No runtime behavior changed from 0.18.3.

## 0.18.3 (2026-11-22)

- **`carl doctor` now checks that the Codex login can actually refresh.** A saved grant whose refresh token was rotated away no longer shows as signed in; doctor names the account and asks for a new login.
- **Held Telegram replies no longer repeat the same expiry warning.** When two gateway processes share an outbox, the expired reply is removed and logged once per state change.

## 0.18.2 (2026-11-20)

- **A run longer than its own interval no longer shows as overdue.** A job that runs past its next slot (an every-20-minutes job running 40 minutes) skips that slot, as before, and its next run now moves to the following slot instead of staying in the past, where UltraTerm read it as a missed run. A scheduler that has really stopped still shows as overdue. Regression test in `test/restart-interrupt.test.ts`.

## 0.18.1 (2026-11-20)

- **A long-running schedule no longer shows as overdue in UltraTerm.** While a job ran, its next run stayed on the slot it had just started, so a 55-minute render showed "1 schedule overdue" from 15 minutes in until it finished, though it was running. A run now moves the next run to the following slot the moment it starts. Interrupted runs still run once more at the next start. Regression test in `test/restart-interrupt.test.ts`.

## 0.18.0 (2026-11-20)

- **Per-model guidance (`modelGuidance` in carl.json).** A list of `{ "match", "text" }` rules adds short system-prompt lines for models whose `provider/id` matches `match` (case-insensitive regular expression). It is added per turn for the model the turn starts on: with fallbacks configured that is the router's current pick (so a benched primary's fallback gets its own lines), and one-off runs use their own model. A switch to a fallback in the middle of a turn keeps that turn's prompt; the next turn gets the new model's lines. Carl ships no rule; a bad rule is a named config error. Tests: `test/model-guidance.test.ts`.

## 0.17.2 (2026-11-19)

- **UltraBot's coordinator writes work again after an update.** `carl update` restarts Carl in place (same process, same pid), but the start time Carl wrote for UltraTerm was taken from Node's uptime, which restarts from zero. UltraTerm compares that time with the kernel's and refused every coordinator write from UltraBot (job notes, waivers, incident resets, triage) as "headless" after any update. Carl now reads its real start time from `ps`, and a regression test covers an in-place restart.

## 0.17.1 (2026-11-19)

- **A schedule cut short by a Carl restart no longer shows as failed.** The rerun clears the old "interrupted by restart" note when it starts, and UltraTerm only gets an error for a run that actually failed, so the rail no longer reads "1 schedule failed" after an update.

## 0.17.0 (2026-11-19)

- **Local models managed by Steak Pi work as the model or a fallback.** A `local/<id>` model (with or without a LoRA adapter) is served by the manager's on-demand server; load its Pi extension through `extensions` and set `modelsPath` to the main Pi registry (README, Routing, Local models). Carl already loaded TypeScript extensions; it now also protects the whole package folder of a file extension from the agent, since the extension imports modules outside its own folder.
- **A dead or refused local server falls through to the next model.** A refused connection to a loopback address, or a `steak-pi local: REFUSED (...)` refusal (on hold, quiet day, not enough memory, another server), before any output is handled like an outage: the turn runs on the next `fallbackModels` entry, the local model is benched for 2 minutes, and the log names the cause. Remote connection errors and other unknown errors still fail with their own message.
- **A symlinked extension protects its real package**, and a TypeScript extension with no package folder is logged. Only the address right after `ECONNREFUSED` counts as loopback (a remote IPv6 address ending in `::1` does not). Any loopback provider's bare connection error counts as that server being down.
- **Verified end to end:** with a local model plus a harness LoRA adapter, `carl ask` completed a tool call on `local/<id>`; with a hold set, the reply named `REFUSED (on-hold)`; with a fallback configured, the turn answered on the fallback.
- **`carl doctor` checks local models.** For each model on the `local` provider in the chain it prints what `steak-pi local check <id>` says (fits, or the refusal); a missing `steak-pi` is a warning that names the fix.

## 0.16.7 (2026-11-18)

- **Stray reasoning tags are removed from replies before delivery.** A model that leaked a fragment such as `</think:6124c78e>` after its answer had it sent as part of the reply (the probe reply was "PONG</think:6124c78e>"). Carl now strips reasoning-tag fragments (`</think>`, `<think>...</think>` blocks and their `:ID` forms) from the final reply on every surface (Telegram, API, CLI, schedules, alerts, portal) and from the live preview. Text inside fenced code blocks and inline code is kept, so a reply that quotes the tag still reads correctly.

## 0.16.6 (2026-11-18)

- **The UltraTerm model picker refuses a model Carl cannot resolve.** Before carl.json is written, the picker checks the model exists in the registry Carl uses; an unknown model is refused with a named error and the file is left unchanged. Previously a bad model was written and stopped every reply.

## 0.16.5 (2026-11-18)

- **carl.json can name the model registry separately from the logins.** A new `modelsPath` setting reads the model catalog from the operator's main Pi registry (`~/.pi/agent/models.json`), while `auth.json` still comes from `agentDir`. A copied `models.json` in a fallback folder can no longer drift from the models the operator routes to: a stale copy used to make a routed model "not in Pi's registry". Without `modelsPath` nothing changes: the catalog is read from `agentDir/models.json` as before.

## 0.16.4 (2026-11-18)

- **An unresolvable primary model no longer stops the gateway while a fallback answers.** When `model` in carl.json is not in the model registry (for example a model removed from the operator's Pi registry after a reboot), Carl logs a named error, starts on the first fallback in `fallbackModels` that resolves, and sends the operator one alert to the home chat. It exits (code 78) only when no configured model resolves, and the error names the primary model.

## 0.16.3 (2026-11-17)

- **`carl update` gives a shared release its Node runtime link.** When a second bot on the same app folder adopted a release the first had installed without a `node` link, `carl send` from a clean environment failed with "node: not found" (exit 127) while the gateway itself kept running. The shared release now gets the link it was missing.

## 0.16.2 (2026-11-17)

- **Queue failures stay out of Telegram work groups.** Carl acknowledges the request without saying it was queued, and sends the full cause, group, title and message ids to the operator’s Telegram home chat. Replies that disclose internal failures or promise a named person will follow up are checked before sending; if a rewrite still fails the check, Carl sends a neutral acknowledgment instead.

## 0.16.1 (2026-11-15)

- **`--help` on a command prints its usage and does nothing else.** `carl update --help` used to install the latest release and restart the running gateway. Every command and nested verb (`update --rollback`, `reflect --revert`, `post schedule` and the rest) now answers `--help` or `-h` before any setup, download, file write or signal, and exits 0. A `--help` inside a message (`carl send ... "use --help"`) is still sent as text.
- An unknown command suggests the closest names.

## 0.16.0

- **The individuation pass acts on its own proposals.** Each proposal is tagged by the pass and checked by Carl. One that
  only changes Carl's own phrasing or adds a check before a claim becomes a standing procedure (`psyche/procedures.jsonl`,
  in the prompt from the next turn); the nightly report lists each with its revert command (`/reflect revert <id>` or
  `carl reflect --revert <id>`), and a reverted one is never re-adopted automatically. A proposal that touches
  permissions, money, client data, messages to other people, configuration or someone else's authority is never applied:
  it is queued for the operator (`psyche/proposals.jsonl`, `/reflect pending`). Repeats are not applied or queued twice.
  Before, proposals were only reported and nothing acted on them.
- **The pass no longer re-reports old incidents.** It read the last 40 entries of every session touched since the last
  run, so replies from days earlier were evidence again each night, and it could restate current lessons as new
  contradictions. It now reads only replies written since the last run and is told a lesson is not evidence.
- **Work status claims need a record.** Work groups get `work_status` (the jobs Carl queued: id, time, message ids). A
  reply in a work group that says work is queued, held or stopped without a job id, and without a work tool run in that
  turn, is sent back to the agent once to check and reply again; one that still fails is recorded in the shadow
  (`unverified_claim`).

## 0.15.2

- Security: the agent SDK moves from 1.0.4 to 1.5.0, which clears the `minimatch` advisory GHSA-g3hv-75wg-m249. `npm audit` reports no vulnerabilities.
- `typebox` is now a declared dependency (Carl's tools import it directly; the SDK no longer re-exports it).

## 0.15.1

- Correct cron day matching when a day field starts with a wildcard step. For example,
  `0 8 */1 * 0` now runs on Sundays, not every day. Two restricted day fields still use OR.
  Existing schedules using wildcard day steps may run less often after this fix.
- Reject interval values that overflow integer milliseconds instead of saving an unusable next-run time.
- Shorten installation instructions and clarify network access, API authentication and platform sandbox limits.

## 0.15.0

- **A group can stop the work it queued.** Add `"stopCommand": ["/abs/stop-script", ...]` to `work` and the agent gets
  a `work_stop` tool. When someone in a work group asks to stop, halt or cancel the work, Carl runs your command with
  `{chat, project, job?, all, reason, requestedBy}` as JSON on stdin and tells the group its answer: exit 0 means
  halted, any other exit means not halted and the printed text is the reason. Before, the agent had only `work_queue`,
  so a request to stop a running job could end up as a second job queued behind the first. The chat and project come
  from the conversation and config, never from the model. Without `stopCommand` nothing changes.

## 0.14.0

- **Queued work now carries the files people attached.** The JSON your work command receives has a new `files` list:
  the absolute paths of the files Carl saved for the messages named in the request (empty when there are none). Before,
  a photo or document sent with a request never reached the job. The agent is told to include the ids of messages
  that carried a file.
- **A failed run no longer shows its cause in a shared chat.** A provider's error text, such as a usage-limit notice,
  was posted into groups and member chats. Those chats now get "I could not answer that just now" and a prompt to
  resend. The cause goes to the gateway log and, as one message, to `telegram.homeChat` with the chat name and an
  excerpt of the message that failed. Your own private chat still shows `Run failed: <cause>`.

## 0.13.2

- **Chat replies no longer say which model answered.** When the primary model was at its usage limit, a Telegram reply
  ended with a note such as "(sonnet answered: terra is at its usage limit until 07:02 PM)". Group members don't need
  that. The operator still sees fallbacks in the gateway log (the `fallback` event) and in the portal's `limits`.

## 0.13.1

- **A provider content-filter refusal moves the turn to the next model instead of failing it.** A provider's input
  inspection can refuse ordinary engineering text before any output: an HTTP 400 whose error code names content
  inspection or moderation (`data_inspection_failed`, `content_policy_violation`, `content_filter` and similar). The
  router now treats that refusal as a fall-through cause, matched by the response shape only, never by provider name.
  Before output the next model answers the same turn; the refusal is not a bench, so the model is not held out for
  the next turn. After output the turn finishes on the model that started it, as for every other refusal. A bare 400
  (bad request, context length) still fails with its own named cause.

## 0.13.0

- **Plan first, pay-per-use last.** A subscription plan stops answering when it is used up, so a chain of plans alone goes quiet. Mark a pay-per-use model in `carl.json` with `"meteredFallbackModels": ["<provider>/<model>"]` (each entry must also be in `model` or `fallbackModels`; a name that is not is a config error). A turn or one-off run that moves to a marked model logs one warning per bench window of the model it replaces, and the `fallback` event carries `metered: true`, so paid use is visible. `carl doctor` warns, without failing, when no model in the chain is marked, and labels each marked model's login `(pay-per-use)`. `carl init` prints the recommended order as step 3b and writes `meteredFallbackModels: []`. No config is required: a file without the key behaves as before.

- **`carl send` cannot post to a chat this bot is not configured for.** It now applies the gateway's own check (home
  chat, allowed users, configured groups) before reading the token, with a named refusal that points to the operator's
  reporting route. A send to a group the bot is not in used to reach Telegram and fail with "chat not found".

## 0.12.4

- **Installer and update hardening.** `carl update` now works on a machine whose Node was fetched by the installer (npm finds its own Node) and on Linux systems without `/usr/bin/tar`. The installer no longer deletes a release another link uses or the rollback when you reinstall the same version, ignores a truncated download, stops on Ctrl-C, accepts a relative `CARL_HOME`, stops early on Alpine (musl) with what to install, and the Windows script handles user names with spaces and restores your environment. Release bundles build the same way on macOS and Linux.

## 0.12.3

- **A download, not just a clone.** Every release now carries `carl.tar.gz` (the 0.5 MB bundle), `install.sh` (macOS and Linux), `install.ps1` (Windows, through WSL) and `SHA256SUMS`. `curl -fsSL https://github.com/michael-berardi/carl/releases/latest/download/install.sh | sh` checks the checksum, uses your Node 22.19+ or fetches the official Node into `~/.carl/app/runtime`, installs the dependencies, proves the new copy starts, and links `carl` into `~/.local/bin`. The layout is the one `carl update` keeps, so updates and `carl update --rollback` work right after install. `scripts/build-release.sh` builds the assets; a test runs the installer against a fake release under `sh` and `dash`. Cloning still works.

## 0.12.2

- **A restart never fails a running schedule.** Stopping or restarting the gateway used to kill a running command job and record `schedule failed ... exit null`, with a failure message delivered, even though the job was healthy. Now a running command job gets a short grace (2 s) to finish on its own, then SIGTERM, then SIGKILL; whatever is still running is recorded as `interrupted by restart (<signal>)`, which is not an error and delivers nothing. A job found interrupted at the next start (including one left `running` by a hard kill) runs once more right away if it began within the last 12 hours and was not itself a rerun; otherwise it waits for its next slot. The job's own lock files still decide whether it may start. Prompt and built-in jobs aborted by the shutdown are treated the same way. Scheduled posts keep their own retry rules (a click that started is never repeated). A command killed by a signal reports `killed by signal SIGTERM`, never `exit null`. No config change.

## 0.12.1

- **Every model call follows the fallback chain.** One-off runs (the nightly individuation, conversation titles, any side call) used to call their model directly, so a usage-limit refusal failed the run even when chat turns fell back fine. They now behave like a turn: a usage limit, quota, credit or 5xx refusal before any output benches that model for its cooldown, logs `primary model unavailable; retrying the one-off run on the next model in the fallback chain`, and repeats on the next configured model. A model already benched is skipped up front. As for turns on a model picked by hand, a call whose model is not part of `model` + `fallbackModels` has no fallback and fails with the provider's own words, as does any call when no fallback is configured. No config change.

## 0.12.0

- **Voice notes, transcribed locally with UltraVox (optional).** Set `"ultravox": {"enabled": true}` and Telegram voice notes and audio files, and Slack and Discord audio attachments, are transcribed on your Mac by the UltraVox app and reach the agent as `[voice note] <text>`. Off by default; nothing changes without it. UltraVox's own custom dictionary is applied (plus `ultravox.dictionary`, an optional extra word list), `ultravox.model` picks `v2` or `v3`, and `ultravox.app` points at an install in another folder. It runs inside the shell sandbox, one file at a time, with a 120 s limit; when it fails, the note names the cause. `carl doctor` reports the control program, version and model, and `carl setup` offers it (default No) only where UltraVox is installed. Setting both `ultravox` and `stt` is a config error. Needs UltraVox 0.13 or newer.

## 0.11.4

- **Neutral, in one line.** The README now reads: Carl is a neutral tool, with no preferred model, harness or ideology. You give it its values.

## 0.11.3

- **Neutral, said plainly.** The README states it in two words: Carl is ideologically neutral, and favors no model, provider, platform or company. The starter `self.md` is unchanged from 0.11.2.

## 0.11.2

- **Neutral, stated in full.** Carl's neutrality covers more than models: it takes no side in politics, religion or ideology, and none between nations or governments. The README now says so, the starter `self.md` adds nations and governments to the contested questions it stays neutral on (an existing `self.md` is yours and is not changed), and a test keeps the README wording complete.

## 0.11.1

- **Claude keeps working after an update.** Restarting in place after `carl update` could leave the private link to `claude` pointing at itself, so every Claude call and scheduled job failed with "Claude Code is not installed" until the next full restart. Carl now links each program to its real file and keeps your original PATH across the restart.

## 0.11.0

- **Feedback intake.** Optional feed polling requires `work.command` and `work.sandboxed: true` (the operator must ensure sandboxing). The command receives email and context; queue commands should deduplicate on feedbackId + source. Successfully queued items are acknowledged.

## 0.10.1

- **Principles.** The README now opens with what Carl stands for: private (everything stays on your machine, nothing is sent to us), free (MIT, no paid tier) and neutral (no favored model, provider or company, and no political, religious or ideological view of its own). A test keeps them in the README.
- **Neutral by default.** The starter `self.md` adds: on contested questions of politics, religion and ideology, give each main view its strongest fair case, keep facts as facts, and leave the judgment to the operator. An existing `self.md` is yours and is not changed.

## 0.10.0

- **Carl updates itself.** It checks its GitHub releases once a day and tells you in the Telegram home chat when a new one is out (once per version), and `carl status`, `carl doctor` and the web app show it too. Send `/update` or run `carl update` to install it: the release is unpacked beside the current one, its dependencies are installed and loaded, and it must start before Carl switches to it. The gateway then restarts on it as soon as nothing is running, keeping its pid. `carl update --check` only checks; `carl update --rollback` goes back to the previous release (one is kept; older unused release folders are removed). A git checkout updates by fast-forwarding to the release tag. Set `"update": {"auto": true}` to install without asking, or `"update": {"check": false}` to never check.
- **Private by default.** Carl sends nothing to us: no analytics, crash reports or usage data. The Pi SDK now runs offline (no version checks, install reports or model-catalog fetches) and adds no attribution headers to provider requests. Claude Code runs with telemetry, error reporting, surveys and nonessential traffic off. The only request Carl makes on its own is the daily release check, which sends nothing about you; `CARL_OFFLINE=1` turns that off too. A Privacy section in the README lists every connection. **Upgrading:** an `npm:` or `git:` extension that is not installed yet is no longer downloaded at start; install it once with `PI_OFFLINE=0`.
- **`carl setup`.** A guided first run: pick Telegram, Slack, Discord or the web app; for Telegram, paste the BotFather token and send your bot a message, and Carl records who you are. Tokens and a generated API key go into `~/.carl/.env` (mode 600). It then helps you choose a model and runs `carl doctor`. `carl init` in a terminal runs it too; re-running fills in only what is missing.
- **Files both ways on every channel.** The agent's `send_message` takes a `file` and a `here` target: images and documents go back into the same Telegram chat or topic, Slack thread or Discord channel (photos fall back to documents when Telegram refuses them). Files are read under the agent's sandbox, so it cannot send Carl's secrets. Slack and Discord now receive files and images like Telegram does (20 MB cap; saved privately under `media/`).
- **Discord threads and Slack threads** keep their own conversations, and replies stay in them. `carl doctor` checks Slack and Discord tokens.
## 0.9.4

- **Clear login guidance before choosing a model.** `carl doctor` skips the primary login check when no model is set, instead of reporting an empty provider and an unusable login command. Configured fallback providers are still checked by name.

## 0.9.3

- **A plan that cannot run the model moves the work on.** When the provider refuses the model for the signed-in account's plan (for example a paid login that lapsed to a free plan: "model is not supported when using ... with a ... account"), the next model in `fallbackModels` answers instead of the run failing, and the refused model is benched for 6 hours. Before, the gateway stopped on every message.

## 0.9.2

- **The browser relay is closed whenever `post.browser` is set, with or without `post.accounts`.** The sandbox denies (control folders, descriptors and their `runtime_root`, `socketPattern`, local port 9222) and the shell `commandPattern` hardline no longer wait for an account. **Upgrading:** an agent shell that used the relay with no accounts configured now loses it.
- **Honest cards.** A card raised through `carl post` reads `Asked by: API (carl post)` (it is a key holder, not necessarily you), the deny cool-down now covers API-raised cards too, and `POST NOW` shows when the dry run is skipped. A slot set through the API now notifies you like an agent's. The restart error names a restart as a cause of a void approval.
- `carl post` makes a draft path absolute against your folder; a bad `post.browser.socketPattern` / `commandPattern` fails at config load; a live `readOnlyHint: false` overrides a cached `true`; approval sentences drop a qualifier word ("add a job", not "add a team job"); README and POSTING.md corrected (restarts, the key, who can force a slot).
- The neutrality test also scans `bin/`, `scripts/`, `.mjs` and `.html` for `overseer`, `coordinator_`, `coordinator-` and `ut-coordinator`. The launcher no longer names any: `CARL_PASS_ENV` (space- or comma-separated variable names, default empty) lists extra variables it passes through; credential-looking names never pass.

## 0.9.1

- **Carl names no coordinator.** No server or tool name of any one coordinator is hardcoded any more. A trusted MCP server's tool runs without asking when its listing carried `readOnlyHint: true` (read from the live listing, and cached in `state/mcp-readonly.json`) or when you list it in the new `guard.readOnlyTools` (`["server/tool", ...]`); everything else asks as before. The browser relay's folders, descriptors, environment overrides, socket-name pattern and shell-command pattern come from the new `post.browser` config (empty by default: Carl closes nothing it was not told about), and `post.accounts.<key>.session.command` is now required. `ultraterm.overseerBin` is now `ultraterm.controlBin` (optional; decision buttons and account ordering need it), and files its helpers keep secret go in `ultraterm.secretFiles`. **Upgrading:** set these in `carl.json` (see `docs/POSTING.md`, "Keeping the browser relay out of the agent's reach"); the neutrality test now fails on any `overseer` or `coordinator_` literal in `src/`.
- **A post guard that does not depend on which tools are auto-allowed.** Posting no longer turns off because of `guard.allowTools`, `guard.operatorTools` or a work queue; those checks (and `postingBlockedReason`) are gone. Instead the act of posting needs your live Telegram press: the approval key lives only in the running gateway's memory (generated at start, never on disk; the key file and its sandbox deny are gone); every click (`now`, a scheduled fire, `clear-pending`, `record-live`) runs inside the gateway after a card press verified in that process; and `carl post` is only a client of the gateway's API (`POST /carl/post`, 127.0.0.1, `CARL_API_KEY`) that raises the card, so a worker running `carl post now` can only request one. `carl post now` is new as a card (`POST NOW`). An approval is good for 24 hours and one post attempt, and a gateway restart voids every approval and dry-run record (approve and dry-run again); a scheduled slot posts from the approval the gateway holds until the slot. `carl post schedule` refuses a slot after the approval expires. What remains is documented: a same-user process could drive the browser relay directly, outside Carl; the X account's own session is the boundary.

## 0.9.0

- **Post primitive.** `carl post dry-run | approve | now | schedule | clear-pending | record-live | status` publishes a post or thread from a Markdown draft, through one adapter contract per platform (`src/post/types.ts`, `src/post/registry.ts`). X is the first adapter, driven through an owned `overseer-browser` session. Accounts live only in `carl.json` (`post.accounts`); shipped code names none. See `docs/POSTING.md`.
- **Posting is off by default** and stays off while it could be walked around: with `post.accounts` set, every `guard.allowTools` and `guard.operatorTools` entry must match only tools that are verifiably read-only (the built-in read list, or a trusted server's `readOnlyHint: true`), and an entry that could match a future tool name (`.*`, `^overseer/coordinator_.*`) or any terminal-typing or worker-starting tool keeps posting off. A work queue whose jobs may run unsandboxed does too. `carl post status` says exactly why.
- **Your approval, on your channel.** `approve`, `clear-pending` and `record-live` only create a card in the Telegram home chat showing the exact parts, account, profile and text hash; the action runs only when a user in `telegram.allowFrom` presses Allow on that card. The approval is a keyed MAC over the text, account, profile and draft path, separate from the dry-run hash, so an edited, moved or copied draft needs fresh approval. The agent can ask for a card, never answer one.
- **Never two posts.** A write-ahead record (draft plus a state ledger, fsynced) is written before every click; any failure after a click is final and never retried; a rerun only looks for the pending part and records it when found. Before clicking, text already live after approval is refused. A post counts only when its whole text matches and X created it after approval and after the previous part.
- **Durable scheduling.** A one-time `post` schedule job fires at its slot and skips a slot missed by more than `post.missedWindowMinutes` (180), saying so. The agent may give an approved draft its first slot only at least 15 minutes out, and only if you are told; it cannot run, resume, remove or pause a post job.
- **Sandbox.** With posting configured, the agent's shell cannot reach the browser relay's socket, its runtime folders, the approval key or the local debug port.
- **Unattended reads.** The built-in read-only list matches the current `coordinator_` tool names, so unattended runs are no longer refused `coordinator_job_list` and similar reads.
