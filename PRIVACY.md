# Privacy

Carl sends no telemetry, analytics, crash reports or usage data. There is no account with us and no install ID.

## What goes over the network

- Prompts, files and tool results go only to the model providers, chat platforms, tools and integrations you configure. Tools, MCP servers, extensions, webhooks and integrations can make their own requests; their policies apply. A local model you configured works without any network access.
- Carl's only unprompted request to a service it chooses itself is the daily update check below. `CARL_OFFLINE=1` stops it; it does not block other traffic.
- The Pi SDK runs offline (`PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`): it does not report installs, refresh catalogs or add attribution headers. Set `PI_OFFLINE=0` when you need it online, for example to install an `npm:` or `git:` extension.
- Claude Code runs with its telemetry, error reports, feedback surveys, update checks and other nonessential traffic switched off.
- `DO_NOT_TRACK=1` is set by default and passed to npm during install and update, to sandboxed shell commands and to the post runner.

## The update check

On its own Carl sends at most one anonymous request a day to GitHub (more only when you ask: `carl update`, `carl doctor`, `/update`, Check Now): `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`, where owner/repo comes from its own `package.json`. Headers: `User-Agent: carl-update-check` and `Accept: application/vnd.github+json`. No user or machine id, no Carl version, no usage data, no credentials. It has a 4-second timeout and runs alongside a terminal command or on the gateway's daily timer, never at startup. GitHub sees the request's IP address, as with any web request.

The answer goes into one file, `update-check.json` under `~/Library/Caches/carl` (macOS) or `$XDG_CACHE_HOME/carl` (else `~/.cache/carl`), mode 600: the check time, the latest version, a short excerpt of its notes or the failure's cause, and which version the terminal notice last showed.

The check is off with `CARL_NO_UPDATE_CHECK=1`, `CARL_OFFLINE=1` or `"update": {"check": false}`. The terminal notice is also off without a terminal, in CI and in agent sessions.

## Installing

Only when a release is installed (by you, or automatically if you turned that on) Carl downloads from GitHub, with the same anonymous User-Agent: for a release-folder install the tag's commit id, `SHA256SUMS` and `carl.tar.gz`; a git checkout runs `git fetch` against its own remote.

## Local files

- `CARL_HOME` (`~/.carl` by default) holds settings (`carl.json`), `.env` secrets, transcripts, group archives, logs, schedules and state, written with owner-only permissions (0600 files in 0700 directories). The gateway log rotates at 10 MB, keeping one previous file; old rotated session transcripts are pruned.
- With UltraTerm configured, Telegram delivery receipts are also kept in `~/.ultraterm/logs/ultrabot-messages`.
- The web app keeps its API key in the browser's local storage.
- `CARL_HOME/state/update.json` (mode 600): the gateway's next check time, the last home-chat notice, a skipped version, whether you declined automatic installs, and the last install (for the "updated" message and rollback cleanup).
- `CARL_HOME/logs/auto-update.log`: background installs, one file kept under 256 KB.
- `update.check` and `update.auto` in `CARL_HOME/carl.json`.

Downloads unpack into a temporary folder beside the release, removed on success and on failure. One rollback copy is kept and removed after the new version has run once, or seven days at most.

## Removing everything

Stop Carl, then run `carl update --auto off`, which removes the check cache, the only update file outside `CARL_HOME`. Delete the app folder and `CARL_HOME`, delete `~/.ultraterm/logs/ultrabot-messages` if you used UltraTerm, and clear the web app's site data in your browser. Accounts and credentials you configured outside `CARL_HOME` (provider logins, chat bots) are not removed.
