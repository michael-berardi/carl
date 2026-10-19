# Carl

Carl is the bot you message to run your AI agents. Ask what they are doing, tell them what to do next, and approve anything risky with a tap, from your phone or desk.

It is built for people who run many agents at once and need a supervisor that answers in seconds instead of burning the budget. On the same model and the same job-status question, Carl answered in 20.8 s on 67k prompt tokens where the Hermes gateway it replaced took 40.8 s on 373k (measurements below).

Technically, Carl is a small, fast bot gateway for getting work done with AI agents. One process runs one agent per conversation and connects it to Telegram, Slack, Discord, a web app, an OpenAI-compatible API and a scheduler. It runs Claude through your own Claude Code login, GPT through your Codex login, or any of about 40 other model providers.

It is built the way [Pi](https://pi.dev) is built: a small core that does its job well, with everything else added as modules. Carl's own code is about 7,000 lines of TypeScript plus a 500-line web app. It runs from source on Node 22 with no build step and has one runtime dependency, the Pi SDK, which supplies the agent loop, sessions, compaction, MCP and the model providers. You never need to install or run Pi itself.

The SDK carries every provider's client library, so a production install is about 160 MB on disk; only the providers you use are loaded, and a running gateway uses about 55 MB of memory.

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

## Install

```sh
git clone https://github.com/michael-berardi/carl && cd carl
npm ci --omit=dev && npm link      # puts `carl` on your PATH
carl init                          # creates ~/.carl with a starter carl.json
```

Then:

1. Put `TELEGRAM_BOT_TOKEN` and `CARL_API_KEY` (16 or more characters) in `~/.carl/.env` and `chmod 600` it.
2. Add your Telegram user id to `telegram.allowFrom` and `telegram.homeChat` in `~/.carl/carl.json`. Carl answers nobody else.
3. Sign in to a model:
   - **Claude:** install Claude Code and run `claude auth login`.
   - **GPT through Codex:** `carl login openai-codex`.
   - **Anything else:** `carl login` lists the providers and which are already set up; `carl login <provider>` signs in (add `--api-key` for a key). Logins are stored in `~/.carl/agent/auth.json`; set `agentDir` to share another app's folder instead.
4. Run `carl doctor`, then `carl gateway`.

Open `http://127.0.0.1:8642/` for the web app. In Chrome or Safari, *Install* (or *Add to Dock*) turns it into a desktop app window.

## What you get

- **Telegram, Slack and Discord:**
  - Answers, not progress: the chat gets one final reply, with no draft frame and no tool line. Set `telegram.stream` to `true` to watch replies being written instead (Telegram only).
  - Every message Carl delivers on Telegram is recorded in UltraTerm's UltraBot message log (`~/.ultraterm/logs/ultrabot-messages/hermes.jsonl`) when `ultraterm` is configured, so `utp ultrabot audit` covers a Carl-served chat.
  - A message sent while Carl is working joins the current turn instead of waiting in a queue.
  - `/stop`, `/new`, `/status`, `/model`, `/compact` and `/mirror` work at any time.
  - Voice notes go through any speech-to-text command you configure; photos and files go to the model.
  - Slack connects over Socket Mode (no public URL needed). Discord connects over its Gateway.
  - Replies that fail to send are retried for 24 hours. If Carl restarts mid-reply, it picks the message up again when its answer had not run any tool yet, and otherwise tells you which message was interrupted (it never repeats an action on its own).
- **Web app:**
  - Chat with any conversation, including the Telegram one.
  - Manage schedules.
  - Read and edit the psyche (below).
  - Status and recent log.
  - No framework and no build step.
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
  - A primary model, plus fallbacks used only when the primary is provably out of quota (see Routing).
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

`model` is the primary. `fallbackModels` are used only when the provider itself says the primary is out of quota: a plan, usage or session limit, or a 402 or 429 from a subscription route. An outage, a bad login or an unknown error fails with its own message instead of quietly moving your work to another model. A model that hit its limit stays benched until the reset time the provider gave, or 30 minutes if it gave none.

## The psyche

Carl is named after Carl Jung, and its self-model borrows his layers. Each layer is a plain file in `~/.carl/psyche/`.

| Layer | File | What it does |
|---|---|---|
| Self | `self.md` | Values that hold in every situation. They come first in the prompt and outrank the persona. |
| Persona | `persona.md` | Tone and role: what the bot is for you. |
| Shadow | `shadow.jsonl` | An open record of Carl's own failures: tool errors, stopped runs, operator corrections, and mistakes it admits with `shadow_note`. Nothing is hidden. |
| Lessons | `integrated.md` | The shadow, integrated. Each day the individuation pass compares Self with what Carl actually did and rewrites at most 12 lessons. It reports contradictions and proposed fixes to you. |
| Mirror | `decisions.jsonl` | Your decisions and their outcomes, recorded with `decision_log`. `/mirror <dilemma>` reflects a decision back honestly: contradictions with your record, no flattery and no verdict. It ends with the question you most need to answer. |

Only Self, Persona and Lessons enter the prompt. The ledgers stay on disk and are read only when needed.

With the UltraTerm module on, Carl joins UltraTerm's own learning loop instead of running a second one. Dream and Nightmare read Carl's shadow and decision ledgers along with every other agent's work. Lessons Mike approves reach Carl through shared memory. Carl then runs no individuation pass and keeps no `integrated.md` in its prompt. Set `"learning": "carl"` to keep Carl's own pass, or `"ultraterm"` to use UltraTerm's loop without the rest of the module.

## Safety

Carl runs tools with your own permissions, because it does real work. Two layers keep that safe.

**A kernel sandbox for everything the agent can influence (macOS).** Shell commands, MCP servers (except the ones you name in `trustedMcp`), the read, edit and write tools, speech-to-text and command schedules all run under one Seatbelt profile that:

- lets the agent write only its working areas (`workspace`, `memory`, `media`, `spill`), the temp and cache folders tools expect, the npm cache and any folders you list in `agentWritable`. Everything else, including Carl's own files, programs on `PATH`, shell startup files, skills and your other projects, is read-only to it;
- keeps Carl's own code, extensions and any `.pi` extension folder unwritable even inside those areas, and keeps the working areas themselves from being moved or swapped for a link;
- closes UltraTerm's bot folder (`~/.hermes`: the old gateway's config, secrets and backups) except its `scripts`;
- denies reads of credential files: Carl's (`.env`, configured env files, the model logins in `auth.json`, OverSeer's local token) and the usual stores of your other tools (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.kube`, the GitHub CLI's and gcloud's config, Docker's config, Codex's and Claude Code's credential files, the Keychain files), and moving, renaming or hardlinking Carl's;
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

## Configuration

`~/.carl/carl.json` (set `CARL_HOME` to move it). Every key is optional.

```json
{
  "name": "Carl",
  "model": "claude-code/claude-sonnet-5-5",
  "fallbackModels": ["openai-codex/gpt-6.1-sol"],
  "thinking": "medium",
  "contextBudget": 100000,
  "tools": ["read", "bash"],
  "contextFiles": ["~/team/AGENTS.md"],
  "skills": ["~/.agents/skills"],
  "skillAllow": ["deploy", "triage"],
  "telegram": { "allowFrom": [123456789], "homeChat": 123456789, "tokenEnv": "TELEGRAM_BOT_TOKEN" },
  "api": { "port": 8642, "keyEnv": "CARL_API_KEY" },
  "stt": ["/path/to/transcribe", "{file}", "{output}"],
  "claude": { "configDirs": ["~/.claude", "~/.claude-work"] },
  "guard": { "hardline": [["\\bterraform\\s+destroy\\b", "terraform destroy"]] },
  "envFiles": ["~/.config/bot/.env"],
  "shellEnv": ["GITHUB_TOKEN"],
  "agentWritable": ["~/projects/scratch"],
  "trustedMcp": ["overseer"]
}
```

MCP servers go in `~/.carl/mcp.json` (the same format as Claude Desktop). Give them `"exposure": "codemode"` so they stay behind the codemode tool.

## Commands

```
carl gateway            run Telegram, Slack, Discord, the API, the web app and schedules
carl init               create ~/.carl with a starter carl.json
carl login [provider]   list model providers, or sign in to one
carl logout <provider>  remove a provider's stored credentials
carl doctor             check config, model logins, channels and files
carl status             the running gateway's status
carl ask [-c key] text  one turn from the terminal
carl prompt             the exact system prompt and tools, with token counts
carl send -t telegram:<chat> text
carl reflect            run the individuation pass now
carl schedules          list schedules
carl app [--install]    open the web app in its own window; --install adds Carl.app (macOS)
```

## Modules

- **UltraTerm:** `"ultraterm": {"home": "~/.hermes"}` makes Carl a drop-in for UltraTerm's UltraBot slot. It writes the status, transcript and usage files UltraTerm reads and serves the routes its panels use. To run it in that slot, install `scripts/ultrabot-gateway.sh` as `~/.hermes/ultrabot-gateway.sh`: UltraTerm then starts Carl from a clean environment as its own child and restarts it if it exits. List the OverSeer and memory servers in `trustedMcp` so they run outside the sandbox (their acting tools still ask first).
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
