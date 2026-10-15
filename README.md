# Carl

Carl is a small, fast bot gateway for getting work done with AI agents. One process runs one [Pi](https://pi.dev) agent per conversation and connects it to Telegram, a web app, an OpenAI-compatible API and a scheduler. It runs Claude through your own Claude Code login, GPT through your Codex login, or any model Pi supports.

It is built the way Pi is built: a small core that does its job well, with everything else added as modules. Carl's own code is about 5,200 lines of TypeScript, plus a 500-line web app, with one runtime dependency (the Pi SDK). It runs from source on Node 22 with no build step.

## Why it is small

Most bot frameworks send tens of thousands of tokens of instructions and tool schemas with every message. Carl keeps the fixed part of each request small and keeps it the same from turn to turn, so the provider's prompt cache hits.

- **Fixed overhead:** about 2k tokens out of the box. A heavy production setup (15 KB of operator rules, a memory pack, a long persona and 11 skills) measured 11k, against 30k for the Hermes deployment it replaced.
- **MCP through codemode:** MCP servers sit behind one `codemode` tool. The model writes a short script that calls servers in parallel and filters their results, so a 20 KB status dump never enters the context.
- **Capped tool output:** large tool results are cut to their head and tail. The full output is saved to a file the model can read in pieces.
- **Compaction at your budget:** Carl compacts at a context budget you set (100k tokens, say), whatever the model's window is. With [UltraCompress](https://github.com/michael-berardi/ultracompress) installed, compaction is a deterministic brief built in milliseconds with no model call, and a recall tool can still reach anything it dropped.

Measured against the Hermes gateway it replaced: the same four questions, the same model (Claude Sonnet 5.5), through each bot's API, with the same answers.

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
   - **GPT through Codex:** run `pi` and then `/login`.
   - **Anything else Pi supports:** use Pi's own login or `models.json`.
4. Run `carl doctor`, then `carl gateway`.

Open `http://127.0.0.1:8642/` for the web app. In Chrome or Safari, *Install* (or *Add to Dock*) turns it into a desktop app window.

## What you get

- **Telegram:**
  - Replies stream into a draft message as Carl writes them.
  - A message sent while Carl is working joins the current turn instead of waiting in a queue.
  - `/stop`, `/new`, `/status`, `/model`, `/compact` and `/mirror` work at any time.
  - Voice notes go through any speech-to-text command you configure; photos and files go to the model.
  - Replies that fail to send are retried for 24 hours. If Carl restarts mid-reply, it tells you which message was interrupted.
- **Web app:**
  - Chat with any conversation, including the Telegram one.
  - Manage schedules.
  - Read and edit the psyche (below).
  - Status and recent log.
  - No framework and no build step.
- **API:**
  - An OpenAI-compatible `/v1/chat/completions` that streams and keeps conversation state.
  - The `/carl/*` routes the web app uses.
  - Bearer-key auth on every route. The listener binds to loopback by default.
- **Schedules:**
  - Cron syntax, `every 30m`, `@daily` and `once <time>`.
  - Each run starts fresh, so schedules never build up context.
  - Shell-command schedules (created by the operator) deliver their output without a model call.
- **Models:**
  - A primary model, plus fallbacks used only when the primary is provably out of quota (see Routing).
  - Switch the model per conversation or globally.

## The Claude route

Carl reaches Claude through the official, unmodified Claude Code CLI and the login you already have. It never reads, copies or refreshes Claude credentials. The design follows NousResearch's claude-subscription-directsdk Hermes plugin (MIT).

- **One process per call:** each model call starts `claude -p` with stream-json in and out. Claude Code's own tools, skills, settings, slash commands, auto-compaction and session files are all off. Carl runs the agent loop and executes every tool itself; Claude Code is only the model client.
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

## The guard

Carl runs tools with your own permissions. It is not a sandbox; the guard is a tripwire against destructive mistakes:

- **Never runs:** `sudo`, recursive deletes of root, home or system directories, disk formatting, raw device writes, and force-pushes to `main` or `master`.
- **Asks first:** recursive deletes, `git push`, destructive git, killing processes, services, deploys, publishing, production data and billing changes. Also anything that hides the real command: `eval`, `sh -c`, interpreters with inline code, a variable used as the command, and base64-decoded content.
  - In Telegram, Carl sends you the exact command with **Run once** and **Deny** buttons. No answer within 5 minutes means no.
  - Runs with nobody to ask (schedules, the API) refuse instead.
- **File tools:** writes to `.ssh`, `.aws`, shell startup files, LaunchAgents, git hooks and Carl's own config ask first. Reads of `.env`, `auth.json` and private keys are refused.

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
  "envFiles": ["~/.config/bot/.env"]
}
```

MCP servers go in `~/.carl/pi/mcp.json` (the same format as Claude Desktop or Pi). Give them `"exposure": "codemode"` so they stay behind the codemode tool.

## Commands

```
carl gateway            run Telegram, the API, the web app and schedules
carl doctor             check config, model logins, Telegram and files
carl ask [-c key] text  one turn from the terminal
carl prompt             the exact system prompt and tools, with token counts
carl send -t telegram:<chat> text
carl reflect            run the individuation pass now
carl schedules          list schedules
```

## Modules

- **UltraTerm:** `"ultraterm": {"home": "~/.hermes"}` makes Carl a drop-in for UltraTerm's UltraBot slot. It writes the status, transcript and usage files UltraTerm reads and serves the routes its panels use.
- **Your own extensions:** any Pi extension loads through `extensions`. That covers custom tools, providers, MCP bridges and delegation.

## Development

```sh
npm ci
npm run verify          # typecheck + unit tests
npm run test:e2e        # real model, fake Telegram: 18 end-to-end steps
```

`test/e2e.ts` drives the whole gateway against a fake Telegram Bot API and a temporary home. It uses your real Pi or Claude login, so set `CARL_E2E_MODEL` to choose the model.

## License

MIT. `vendor/ultracompress` is the UltraCompress Pi adapter (MIT). See `vendor/ultracompress/UPSTREAM.txt`.
