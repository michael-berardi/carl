# Carl

Carl is the bot you message to run your AI agents. Ask what they are doing, tell them what to do next, and approve anything risky with a tap, from your phone or desk.

It is built for people who run many agents at once and need a supervisor that answers in seconds instead of burning the budget. On the same model and the same job-status question, Carl answered in 20.8 s on 67k prompt tokens where the Hermes gateway it replaced took 40.8 s on 373k (measurements below).

Technically, Carl is a small, fast bot gateway for getting work done with AI agents. One process runs one agent per conversation and connects it to Telegram, Slack, Discord, a web app, an OpenAI-compatible API and a scheduler. It runs Claude through your own Claude Code login, GPT through your Codex login, or any of about 40 other model providers.

It is built the way [Pi](https://pi.dev) is built: a small core that does its job well, with everything else added as modules. Carl's own code is about 7,300 lines of TypeScript plus a 500-line web app. It runs from source on Node 22 with no build step and has one runtime dependency, the Pi SDK, which supplies the agent loop, sessions, compaction, MCP and the model providers. You never need to install or run Pi itself.

The SDK carries every provider's client library, so a production install is about 160 MB on disk; only the providers you use are loaded, and a running gateway uses about 55 MB of memory.

## Download

- **macOS and Linux:** [install.sh](https://github.com/michael-berardi/carl/releases/latest/download/install.sh) (checks the SHA-256 of the 0.3 MB bundle before it installs anything). One command: `curl -fsSL https://github.com/michael-berardi/carl/releases/latest/download/install.sh | sh`
- **Windows (PowerShell, runs Carl in WSL):** [install.ps1](https://github.com/michael-berardi/carl/releases/latest/download/install.ps1). One command: `irm https://github.com/michael-berardi/carl/releases/latest/download/install.ps1 | iex`
- All releases and checksums (`SHA256SUMS`): [latest release](https://github.com/michael-berardi/carl/releases/latest).

## Principles

Carl is private, free and neutral. Every release keeps these three.

- **Private.** Everything stays on your machine. Carl has no account and no analytics, and it sends us nothing. [Privacy](#privacy) lists every connection it makes.
- **Free.** Carl is MIT-licensed and costs nothing, with no paid tier and nothing held back. Use it, change it, share it. The model providers you choose bill you directly.
- **Neutral.** Carl is a neutral tool, with no preferred model, harness or ideology. You give it its values.

## Why it is small

Most bot frameworks send tens of thousands of tokens of instructions and tool schemas with every message. Carl keeps the fixed part of each request small and keeps it the same from turn to turn, so the provider's prompt cache hits.

- **Fixed overhead:** about 2k tokens out of the box. A heavy production setup (15 KB of operator rules, a memory pack, a long persona and 11 skills) measures about 12k, against 30k for the Hermes deployment it replaced.
- **MCP through codemode:** MCP servers sit behind one `codemode` tool. The model writes a short script that calls servers in parallel and filters their results, so a 20 KB status dump never enters the context.
- **Capped tool output:** large tool results are cut to their head and tail. The full output is saved to a file the model can read in pieces.
- **Compaction at your budget:** Carl compacts at a context budget you set (96k tokens by default), whatever the model's window is. With UltraCompress, keep it at 40k or more: the newest turns (up to about 25k tokens) stay verbatim. With [UltraCompress](https://github.com/michael-berardi/ultracompress) installed, compaction is a deterministic brief built in milliseconds with no model call, and a recall tool can still reach anything it dropped.

Measured on 2026-10-15 against the Hermes gateway it replaced: the same four questions, the same model (Claude Sonnet 5.5), through each bot's API, with the same answers.

| Question | Hermes | Carl |
|---|---|---|
| Status from a job system (tool calls) | 40.8 s, 373k prompt tokens | 20.8 s, 67k |
| Rules lookup | 5.8 s, 58.8k | 3.6 s, 18.4k |
| Memory recall | 6.2 s, 58.8k | 3.1 s, 18.4k |
| Short reasoning | 4.4 s, 58.8k | 3.9 s, 18.4k |

Prompt tokens include cached tokens. Carl's cached share was about 97%.

## Privacy

Carl is private by default. It runs on your machine and keeps everything there: conversations, logs, schedules, files, logins and the psyche all live in `~/.carl`. There is no account, no analytics, no crash reporting and no usage data. We see nothing.

Carl connects only to:

- **The model providers you sign in to,** with the messages you send them.
- **The chat platforms you turn on** (Telegram, Slack, Discord).
- **Its own GitHub releases, once a day,** to tell you when an update is out. That request asks for the latest version number and sends nothing about you or your machine. Turn it off with `"update": {"check": false}` or `CARL_OFFLINE=1`.

It also switches off what the libraries underneath would send:

- **Pi SDK:** runs offline (`PI_OFFLINE=1`). It makes no version checks, install reports or model-catalog fetches, and adds no attribution headers to your provider requests.
- **Claude Code:** runs with its documented opt-outs set (`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, surveys and auto-update off).

Your provider still sees what you send it, under its own terms. Choose a provider whose data policy you trust.

## Install

macOS and Linux:

```sh
curl -fsSL https://github.com/michael-berardi/carl/releases/latest/download/install.sh | sh
carl setup
```

Windows (PowerShell; Carl runs inside WSL, which the script checks for):

```powershell
irm https://github.com/michael-berardi/carl/releases/latest/download/install.ps1 | iex
```

The download is a 0.5 MB bundle plus its dependencies (about 160 MB installed). The installer checks the bundle's SHA-256, uses the Node 22.19+ you already have or fetches the official Node into `~/.carl/app/runtime` (nothing global), and puts `carl` in `~/.local/bin`. It installs in the same layout `carl update` maintains, so updates and `carl update --rollback` work from the first day. The files (`carl.tar.gz`, `install.sh`, `install.ps1`, `SHA256SUMS`) are on each [release](https://github.com/michael-berardi/carl/releases/latest).

From source instead (any system with Node 22.19+ and git):

```sh
git clone https://github.com/michael-berardi/carl && cd carl
npm ci --omit=dev && npm link      # puts `carl` on your PATH
```

`carl setup` walks you through the first run:

1. **Channel.** For Telegram, paste the token from @BotFather. Carl checks it, then asks you to send your bot a message, so it knows who you are. It answers nobody else.
2. **Secrets.** Tokens and a generated API key go into `~/.carl/.env`, readable only by you.
3. **Model.** Carl has no built-in model. Pick a provider you are already signed in to, or sign in from setup. Claude runs through your Claude Code login (`claude auth login`).
4. **Check.** `carl doctor` runs and tells you what, if anything, still needs attention.

Then run `carl gateway`. Re-run `carl setup` at any time; it fills in only what is missing.

Open `http://127.0.0.1:8642/` for the web app. In Chrome or Safari, *Install* (or *Add to Dock*) turns it into a desktop app window.

Prefer to edit files? `carl init` without a terminal writes a starter `~/.carl/carl.json`. Put `TELEGRAM_BOT_TOKEN` and `CARL_API_KEY` in `~/.carl/.env` (`chmod 600`), add your Telegram user id to `telegram.allowFrom` and `telegram.homeChat`, and set `"model": "provider/model"`. `carl login` lists providers and signs in to one.

## Updates

Carl checks for a new release once a day. When one is out, it tells you in your Telegram home chat, in `carl status` and in the web app.

- **From your phone:** send `/update`. Carl installs it and restarts on it as soon as nothing is running.
- **From a terminal:** `carl update` installs it; `carl update --check` only checks.
- **Undo:** `carl update --rollback` goes back to the release you had before.

Each update is tested before Carl switches to it: if its dependencies do not install or it does not start, nothing changes and you get the error. Set `"update": {"auto": true}` to install new releases without asking.

## What you get

- **Telegram, Slack and Discord:**
  - Answers, not progress: the chat gets one final reply, with no draft frame and no tool line. Set `telegram.stream` to `true` to watch replies being written instead (Telegram only).
  - Telegram message attempts (delivered, refused or unknown) are recorded in UltraTerm's UltraBot message log when `ultraterm` is configured; secrets are masked before persistence. See [Telegram delivery and audit safety](docs/TELEGRAM-DELIVERY.md).
  - A message sent while Carl is working joins the current turn instead of waiting in a queue.
  - `/stop`, `/new`, `/status`, `/model`, `/compact` and `/mirror` work at any time.
  - **Team groups:** list a group under `telegram.groups` with its members (`{"chat": -100…, "members": {"<user id>": "Alex (editor)"}}`) and Carl serves that team too. In a group it answers only when addressed (an @mention, its name as a word (`name` in carl.json, e.g. "Carl, ..."), a reply to one of its messages, or a command; set `listenAll` to answer everything), and every message names its sender. Members are never the operator: their words cannot approve operator-only tools, approval cards still go to the operator, and they can use only `/help`.
  - Voice notes go through any speech-to-text command you configure; photos and files go to the model, on Telegram, Slack and Discord alike.
  - Carl can send files and images back (a chart, a report, a screenshot) into the same chat or thread, or to your home chat. It can only send files its sandbox lets it read, so its own secrets never leave.
  - Slack connects over Socket Mode (no public URL needed) and answers in threads. Discord connects over its Gateway and keeps each thread its own conversation.
  - Replies Telegram explicitly refuses are retried for 24 hours; ambiguous deliveries are held for reconciliation, never automatically replayed. If Carl restarts mid-reply, it picks the message up again when its answer had not run any tool yet, and otherwise tells you which message was interrupted (it never repeats an action on its own).
- **Web app:**
  - Chat with any conversation, including the Telegram one.
  - Manage schedules.
  - Read and edit the psyche (below).
  - Status and recent log.
  - No framework and no build step.
- **Group archive and history:** Carl keeps every message of every group it is in (addressed or not, from members or not) in `CARL_HOME/groups/<chat>/messages.jsonl` (private, edits applied), and the agent reads it with `group_history`. In a group conversation it reads only that group; in the operator's own chat it reads any. Nothing is forwarded or sent to read history.
- **Work (module, off by default):** set `"work": {"command": ["/abs/queue-script", ...]}` and give a group `"work": {"project": "<name>"}`. When someone in that group asks Carl to queue the work (for example "@bot queue the feedback"), the agent reads the group, keeps the real requests, and calls `work_queue`: Carl runs your command with `{chat, project, title, request, messageIds, requestedBy}` as JSON on stdin and returns its answer (for example a job id). The chat and project come from the conversation and config, never from the model. `group_history` with `unqueued_only` then skips messages already turned into work.
- **Asks (module, off by default):** with `"asks": true`, Carl can put questions to someone in a chat and act on the answers. Write `~/.carl/asks/<id>.json` (`chat`, `askee`, `title`, `questions` as `[{n, text}]`, an absolute `answersFile`, and optionally `onComplete`, an argv run when every answer is in), then `carl ask-post <id>`. While an ask is open, the askee's messages in that chat reach Carl without an @mention (their configured member name must start with the ask's `askee`). When they reply, the agent records each answer, asks a follow-up if one is unclear, and finishes the ask: the answers are written to `answersFile` and `onComplete` runs. The agent can only record and finish; it cannot create an ask or change what finishing runs. Point `onComplete` at your job system (for example `ut-overseer job-report` on a gate job that the follow-up work depends on) and the work starts without you.
- **Webhooks:** `POST /v1/hooks/<name>` turns an event from GitHub, Stripe, a form or another bot into an agent run, with the result delivered where you choose. Requests need the API key or a valid HMAC signature (GitHub's `X-Hub-Signature-256` format). Each delivery is recorded before Carl answers: after a restart, one that had not started runs, and one cut short is reported rather than rerun. A repeated delivery id (`X-GitHub-Delivery` or `Idempotency-Key`) runs once.
- **API:**
  - An OpenAI-compatible `/v1/chat/completions` that streams and keeps conversation state.
  - The `/carl/*` routes the web app uses.
  - Bearer-key auth on every route. The listener binds to loopback by default.
- **Schedules:**
  - Cron syntax, `every 30m`, `@daily` and `once <time>`.
  - Each run starts fresh, so schedules never build up context.
  - Shell-command schedules (created by the operator) deliver their output without a model call.
  - They run in the shell sandbox. To run one of your own scripts outside it (one that needs a login the sandbox hides, such as `cf`'s), set `"unsandboxed": true` on that job in `~/.carl/schedules.json`. The agent cannot set it.
- **Models:**
  - A primary model, plus fallbacks used only when the primary provably cannot answer: out of quota or credits, a 5xx outage, or an OpenRouter route with no endpoints (see Routing).
  - Switch the model per conversation or globally.

## The Claude route

Carl reaches Claude through the official, unmodified Claude Code CLI and the login you already have. It never reads, copies or refreshes Claude credentials. The design follows NousResearch's claude-subscription-directsdk Hermes plugin (MIT).

- **One process per call:** each model call starts `claude -p` with stream-json in and out. Claude Code's own tools, skills, settings, slash commands, auto-compaction and session files are all off. Carl runs the agent loop and executes every tool itself; Claude Code is only the model client. Starting the CLI costs about 0.8 s, so when a reply asks for a tool, Carl starts the next call's process while the tool runs; that call then reaches the API in about 50 ms. The spare is used once, only by a call with the same model, settings, prompt, tools and login, and is stopped after 2 minutes unused.
- **Content only through official inputs:** Carl supplies a system prompt file, history frames, an inventory of its tools (served by an inert MCP server that refuses to run anything), and generation settings.
- **One upstream request per call:** a single-use relay on loopback forwards exactly one request to `api.anthropic.com` and refuses the CLI's own retries.
- **Never billed to an API account by accident:** the relay refuses to forward when the CLI authenticates with an API key instead of the subscription login. `ANTHROPIC_API_KEY` and similar backend overrides are removed from the CLI's environment.
- **More than one login:** with several logins (`claude.configDirs`), Carl moves to the next one only when the first is refused before it has produced any output.

Carl is not affiliated with Anthropic. Use of Claude through your subscription is subject to Anthropic's terms for your plan.

## Routing

`model` is the primary. `fallbackModels` are used, in order, only when the provider itself says the primary cannot answer:

- out of quota or credits: a plan, usage or session limit, an HTTP 402 or 429 (OpenRouter's "insufficient credits" included);
- a 5xx outage, or an OpenRouter route with no endpoints (404 "No endpoints available").

The work moves before any output was written. A failure after output, or after a tool ran, finishes the turn on the model that started it, so the partial answer or the tool call is never duplicated. The warning in the log and the `fallback` event name the provider's own words. A failed model stays benched: until the reset time the provider gave, 2 minutes after a 5xx outage, 10 minutes for a route with no endpoints, or 30 minutes when a quota refusal gave no hint. A bad login or an unknown error fails with its own message instead of quietly moving your work to another model.

**Recommended: plan first, pay-per-use last.** A subscription plan answers until its quota runs out and then refuses until it resets, so a chain made only of plans goes quiet once they are all used up. End the chain with a pay-per-use model, sign in to it with `carl login <provider> --api-key`, and mark it in `meteredFallbackModels`:

```json
{
  "model": "provider-a/plan-model",
  "fallbackModels": ["provider-b/metered-model"],
  "meteredFallbackModels": ["provider-b/metered-model"]
}
```

The metered model takes a turn only after the plans above it are refused. Carl logs that once per bench window and marks the `fallback` event `metered: true`, so paid use is visible. `carl doctor` warns, without failing, when no model in the chain is marked.

Carl uses exactly the `fallbackModels` you list, in order; without the key there are none. A fallback whose provider is unavailable (Claude Code when `claude.enabled` is false, a provider with no login) is skipped with a named warning rather than blocking startup. A model your provider's catalog does not list can be added in the agent folder's `models.json`.

## The psyche

Carl is named after Carl Jung, and its self-model borrows his layers. Each layer is a plain file in `~/.carl/psyche/`.

| Layer | File | What it does |
|---|---|---|
| Self | `self.md` | Values that hold in every situation. They come first in the prompt and outrank the persona. The starter values include neutrality: on contested questions Carl lays out the main views fairly and leaves the judgment to you. |
| Persona | `persona.md` | Tone and role: what the bot is for you. |
| Shadow | `shadow.jsonl` | An open record of Carl's own failures: tool errors, stopped runs, operator corrections, and mistakes it admits with `shadow_note`. Nothing is hidden. |
| Lessons | `integrated.md` | The shadow, integrated. Each day the individuation pass compares Self with what Carl actually did and rewrites at most 12 lessons. It reports contradictions and proposed fixes to you. |
| Mirror | `decisions.jsonl` | Your decisions and their outcomes, recorded with `decision_log`. `/mirror <dilemma>` reflects a decision back honestly: contradictions with your record, no flattery and no verdict. It ends with the question you most need to answer. |

Only Self, Persona and Lessons enter the prompt. The ledgers stay on disk and are read only when needed.

With the UltraTerm module on, Carl joins UltraTerm's own learning loop instead of running a second one. Dream and Nightmare read Carl's shadow and decision ledgers along with every other agent's work. Lessons the operator approves reach Carl through shared memory. Carl then runs no individuation pass and keeps no `integrated.md` in its prompt. Set `"learning": "carl"` to keep Carl's own pass, or `"ultraterm"` to use UltraTerm's loop without the rest of the module.

## Safety

Carl runs tools with your own permissions, because it does real work. Two layers keep that safe.

**A kernel sandbox for everything the agent can influence (macOS).** Shell commands, MCP servers (except the ones you name in `trustedMcp`), the read, edit and write tools, speech-to-text and command schedules all run under one Seatbelt profile that:

- lets the agent write only its working areas (`workspace`, `memory`, `media`, `spill`), the temp and cache folders tools expect, the npm cache and any folders you list in `agentWritable`. Everything else, including Carl's own files, programs on `PATH`, shell startup files, skills and your other projects, is read-only to it;
- keeps Carl's own code, extensions and any `.pi` extension folder unwritable even inside those areas, and keeps the working areas themselves from being moved or swapped for a link;
- closes UltraTerm's bot folder (`~/.hermes`: the old gateway's config, secrets and backups) except its `scripts`;
- denies reads of credential files: Carl's (`.env`, configured env files, the model logins in `auth.json`, plus any files you list in `ultraterm.secretFiles`, such as a control server's local token) and the usual stores of your other tools (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.kube`, the GitHub CLI's and gcloud's config, Docker's config, Codex's and Claude Code's credential files, the Keychain files), and moving, renaming or hardlinking Carl's;
- blocks the routes that run work outside the sandbox or reach your credentials: `osascript`, `open`, `launchctl`, `crontab`, `at`, `shortcuts` and `sudo`, Apple Events, LaunchServices, tmux and Docker sockets, signals to other processes, the Keychain, your SSH agent, and Carl's own API port;
- passes only an allowlist of environment variables (`PATH`, `HOME`, locale, terminal, proxy and similar). Carl's secrets and keys exported in your shell are dropped; list names the agent should get in `shellEnv` (their values may live in the env files).

Programs Carl itself starts outside the sandbox (Claude Code, UltraTerm's helpers, UltraCompress, trusted MCP servers) are resolved once at startup and run from a Carl-only folder with a `PATH` of folders the agent cannot write. Context files are read inside the sandbox, so a link cannot pull a secret into the prompt. Trusted MCP servers act with your permissions, so every tool of theirs that does more than read (opening workers, typing into terminals, queueing or approving jobs, writing notes) asks you first, also from codemode scripts; their read-only tools run freely. Reading a trusted server's MCP resources asks too. Add read-only tools of your own servers under `guard.allowTools` as `["server/tool regex", "reason"]`. Tools that should act only on your own request go under `guard.operatorTools`: they run without a card only in your own chat (Telegram or the CLI, never a schedule, webhook or the API) and only when the call's `evidence` quotes words from your latest message; otherwise they ask as usual.

The sandbox is a boundary for Carl's own files and secrets and for the rest of your disk, not for the network: the agent can still read your other files (the credential stores above excepted; a key kept somewhere unusual is readable), make network requests and use the authority of the tools you give it. On macOS any program you run can read the startup environment of your other programs, so keep keys in files rather than exported shell variables; Carl lists any credential-like names in its own environment at startup. On Linux and Windows the environment allowlist still applies, and the missing kernel boundary is logged at startup.

**A guard that asks before risky actions.** Commands are parsed into simple commands, respecting quotes and heredocs, and judged by what actually runs:

- **Never runs:** `sudo`, recursive deletes of root, home or system directories, disk formatting, raw device writes, force-pushes to `main` or `master`, and file-tool writes into Carl's control plane.
- **Asks first:** recursive deletes, `git push`, destructive git, killing processes, services, deploys, publishing, production data and billing changes. Also anything that hides the real command: `eval`, `sh -c`, interpreters with inline code, a variable used as the command, and base64-decoded content. File writes to `.ssh`, `.aws`, shell startup files, LaunchAgents and git hooks ask too.
  - In Telegram, Slack or Discord, Carl shows you the exact command (or file content) with **Run once** and **Deny** buttons. No answer within 5 minutes means no.
  - Runs with nobody to ask (schedules, the API) refuse instead.

The guard is a tripwire for mistakes and prompt injection, not a proof. The sandbox is the boundary for Carl's own files and secrets. Carl also holds whatever authority you give it through tools: if it can start workers or drive other apps, it can ask them to act. Programs the sandbox blocks are refused up front with that reason.

Add your own rules under `guard.hardline` and `guard.dangerous` in `carl.json`.

## Posting

Carl publishes a social post from a draft file, now or on a schedule, and never without your approval. A draft is a Markdown file with front matter (`platform`, `account`, `text` or `thread`, optional `reply`). Accounts are defined only in your `carl.json` (`post.accounts`), and X is the first platform (driven through an owned browser session whose tool you name in `session.command`). Posting is a request to the running gateway: `carl post` only raises a card, and only your Telegram press makes the gateway post (see `docs/POSTING.md`).

```
carl post dry-run <draft>      render, validate and prove the exact text fits the composer; posts nothing
carl post approve <draft>      asks: a card with the exact text appears in your Telegram home chat; the approval is recorded only when you press Allow there (editing the draft clears it)
carl post now <draft>          asks: a POST NOW card appears in your Telegram home chat and the gateway posts only when you press Allow there (needs approval and a live dry run); a failure after the click stops for you to check, it never re-clicks
carl post schedule <draft> --at <ISO> [--late post]
carl post clear-pending <draft>  (a card) after you checked the profile and a pending part is not live
carl post record-live <draft> <url>  (a card) a pending part is live at that URL
carl post status
```

A scheduled slot survives a restart, but the restart voids the approval, so the post then fails closed until you approve again. A slot missed by more than three hours (`post.missedWindowMinutes`) is skipped, the draft stays Scheduled and the delivered message says so, unless you chose `--late post`. The agent can draft, dry-run and give an approved draft its first slot through its `post_draft` tool but cannot approve, answer a card, post at once, schedule closer than 15 minutes, change a slot, or run a scheduled post; the approval is an HMAC under a key that exists only in the running gateway's memory (never on disk), and it is recorded only when you answer the card on your own channel. See [docs/POSTING.md](docs/POSTING.md).

## Configuration

`~/.carl/carl.json` (set `CARL_HOME` to move it). `model` is required; every other key is optional. `carl init` writes the file with an empty `model` for you to fill in.

```json
{
  "name": "Carl",
  "model": "provider-a/model-name",
  "fallbackModels": ["provider-b/other-model"],
  "thinking": "medium",
  "contextBudget": 100000,
  "tools": ["read", "bash"],
  "contextFiles": ["~/team/AGENTS.md"],
  "skills": ["~/.agents/skills"],
  "skillAllow": ["deploy", "triage"],
  "telegram": { "allowFrom": [123456789], "homeChat": 123456789, "tokenEnv": "TELEGRAM_BOT_TOKEN",
                "groups": [{ "chat": -1001234567890, "members": { "987654321": "Alex" } }] },
  "api": { "port": 8642, "keyEnv": "CARL_API_KEY" },
  "stt": ["/path/to/transcribe", "{file}", "{output}"],
  "claude": { "configDirs": ["~/.claude", "~/.claude-work"] },
  "guard": { "hardline": [["\\bterraform\\s+destroy\\b", "terraform destroy"]] },
  "envFiles": ["~/.config/bot/.env"],
  "shellEnv": ["GITHUB_TOKEN"],
  "agentWritable": ["~/projects/scratch"],
  "trustedMcp": ["my-control-server"]
}
```

**Voice notes with UltraVox (optional).** `"ultravox": {"enabled": true}` transcribes Telegram voice notes and audio files, and Slack and Discord audio attachments (`audio/*`, ogg, m4a, mp3, wav), locally with the UltraVox app (0.13 or newer); the agent sees `[voice note] <text>`. It is off unless you enable it. Options: `app` (the UltraVox.app folder, default `/Applications` then `~/Applications`), `model` (`"v2"` English or `"v3"` multilingual; default is UltraVox's own setting) and `dictionary` (a file of extra `Word = heard one, heard two` lines, applied after UltraVox's own custom dictionary). The control program runs inside the shell sandbox, one file at a time, with a 120 s limit. A failure is logged and the note says why (not installed, too old, no speech, timeout). `carl doctor` shows the program, its version and the model, and `carl setup` asks (default No) only when UltraVox is installed. `ultravox` and `stt` cannot both be set: Carl refuses that config and names both.

MCP servers go in `~/.carl/mcp.json` (the same format as Claude Desktop). Give them `"exposure": "codemode"` so they stay behind the codemode tool.

## Commands

```
carl gateway            run Telegram, Slack, Discord, the API, the web app and schedules
carl setup              guided first run: channel, secrets, model, check
carl update [--check|--rollback]  install the latest release, only check, or go back
carl init               create ~/.carl with a starter carl.json
carl login [provider]   list model providers, or sign in to one
carl logout <provider>  remove a provider's stored credentials
carl doctor             check config, model logins, channels and files
carl status             the running gateway's status
carl ask [-c key] text  one turn from the terminal
carl prompt             the exact system prompt and tools, with token counts
carl send -t telegram:<chat> text
carl ask-post <id>      post an ask's questions (asks module)
carl reflect            run the individuation pass now
carl schedules          list schedules
carl post <command>     draft posts: dry-run, approve, now, schedule, status
carl app [--install]    open the web app in its own window; --install adds Carl.app (macOS)
```

When `model` is unset, `carl doctor` skips its primary login check and asks you to set a model before signing in. Configured fallback logins are still checked separately.

## Modules

- **Feedback intake:** Off unless `feedback` is set alongside `work.command` and `work.sandboxed: true` (the operator must ensure jobs run sandboxed; Carl cannot verify this). Example:

  ```json
  {"work":{"command":["/abs/queue-script"],"sandboxed":true},"feedback":{"intervalMinutes":15,"sources":[{"name":"example-site","url":"https://example.com/api/feedback/feed","tokenEnv":"EXAMPLE_FEEDBACK_TOKEN","project":"example","chat":"telegram:dm:123"}]}}
  ```

  `chat` is optional and uses a Carl send target. Optional per-source `instructions` overrides the neutral default asking to reproduce, diagnose, fix and verify. Feed URLs require HTTPS except for localhost and loopback. Visitor content is untrusted data; page URLs must use HTTP(S) and match the feed host. A poison item is retried with backoff and one notice after five failures; other items on the page continue but the cursor stays put until the item succeeds. Every `intervalMinutes` (default 15), Carl reads each site's feed using the token named by `tokenEnv` (environment or configured env files), queues items through `work.command`, and acknowledges only successfully queued work. Five failures trigger one log and, if configured, a chat notice; retries use bounded exponential backoff. Cursors, attempts and queued references are kept privately in the state directory. Feed data, including email and context, is passed to the command; do not put personal data in job references. A crash between command completion and recording its reference can queue a duplicate: queue commands should deduplicate on `feedbackId` and source.
  The feed `next` must be a keyset (position) cursor that remains valid when earlier items are acknowledged or removed.

  **Feed protocol for site implementers:** `GET <url>?after=<cursor>&limit=50` with `Authorization: Bearer <token>` returns JSON `{ "items": [{ "id": "...", "site": "...", "kind": "bug", "message": "...", "pageUrl": "https://example.com/", "email": "...", "createdAt": "...", "context": {} }], "next": "..." }`. `kind` is `bug` or `idea`; `next` is an opaque cursor or null. Items and cursor ordering must be stable until acknowledged, and an empty `after` means the beginning. `POST <url>/ack` with the same bearer authorization and JSON `{ "ids": ["..."], "ref": "..." }` acknowledges queued items; acknowledgements must be idempotent. Use HTTPS outside local tests.
- **UltraTerm:** `"ultraterm": {"home": "~/.hermes"}` makes Carl a drop-in for UltraTerm's UltraBot slot. It writes the status, transcript and usage files UltraTerm reads and serves the routes its panels use. To run it in that slot, install `scripts/ultrabot-gateway.sh` as `~/.hermes/ultrabot-gateway.sh`: UltraTerm then starts Carl from a clean environment as its own child and restarts it if it exits. Set `ultraterm.controlBin` to UltraTerm's control binary (it enables the Telegram decision buttons and account ordering, and its folder is protected), and list your control and memory servers in `trustedMcp` so they run outside the sandbox. Carl names no server or tool of its own: a trusted server's tools run without asking only when their MCP listing carries `readOnlyHint: true` or you list them in `guard.readOnlyTools` (`["server/tool", ...]`); every other tool asks first unless you allow it in `guard.allowTools` / `guard.operatorTools`. The launcher passes through only terminal, locale and UltraTerm variables; to pass others (never one whose name looks like a credential), set `CARL_PASS_ENV` to their names, separated by spaces or commas (default empty).
- **Your own extensions:** any Pi-SDK extension loads through `extensions`. That covers custom tools, providers, MCP bridges and delegation.

## Development

```sh
npm ci
npm run verify          # typecheck + unit tests
npm run test:e2e        # real model, fake Telegram: 20 end-to-end steps
```

`test/e2e.ts` drives the whole gateway against a fake Telegram Bot API and a temporary home. It uses your real Codex or Claude login, so set `CARL_E2E_MODEL` to choose the model.

## License

MIT. `vendor/ultracompress` is the UltraCompress adapter for the Pi SDK (MIT). See `vendor/ultracompress/UPSTREAM.txt`.

---

Part of [Pareto Cybernetics](https://paretocybernetics.com/projects/carl/): free, private, open-source tools for working with AI agents.
