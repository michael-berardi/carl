# Privacy

Carl keeps conversations, logs, schedules, files and credentials under `CARL_HOME` (`~/.carl` by default). Messages go to the model providers and chat platforms you configure. Tools, MCP servers, extensions, webhooks and integrations can make their own requests; their policies apply. Carl sends no telemetry, analytics or identifiers. The Pi SDK runs offline (`PI_OFFLINE=1`, `PI_TELEMETRY=0`) and Claude Code runs with its telemetry, error-reporting and nonessential-traffic opt-outs.

## The update check

On its own Carl sends at most one anonymous request a day to GitHub (more only when you ask: `carl update`, `carl doctor`, `/update`, Check Now): `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`, where owner/repo comes from its own `package.json`. Headers: `User-Agent: carl-update-check` and `Accept: application/vnd.github+json`. No user or machine id, no Carl version, no usage data, no credentials. It has a 4-second timeout and runs alongside a terminal command or on the gateway's daily timer, never at startup. GitHub sees the request's IP address, as with any web request.

The answer goes into one file, `update-check.json` under `~/Library/Caches/carl` (macOS) or `$XDG_CACHE_HOME/carl` (else `~/.cache/carl`), mode 600: the check time, the latest version, a short excerpt of its notes or the failure's cause, and which version the terminal notice last showed.

The check is off with `CARL_NO_UPDATE_CHECK=1`, `CARL_OFFLINE=1` or `"update": {"check": false}`. The terminal notice is also off without a terminal, in CI and in agent sessions.

## Installing

Only when a release is installed (by you, or automatically if you turned that on) Carl downloads from GitHub, with the same anonymous User-Agent: for a release-folder install the tag's commit id, `SHA256SUMS` and `carl.tar.gz`; a git checkout runs `git fetch` against its own remote.

## Local files

- `CARL_HOME/state/update.json` (mode 600): the gateway's next check time, the last home-chat notice, a skipped version, whether you declined automatic installs, and the last install (for the "updated" message and rollback cleanup).
- `CARL_HOME/logs/auto-update.log`: background installs, one file kept under 256 KB.
- `update.check` and `update.auto` in `CARL_HOME/carl.json`.

Downloads unpack into a temporary folder beside the release, removed on success and on failure. One rollback copy is kept and removed after the new version has run once, or seven days at most.

## Removing everything

`carl update --auto off` removes the check cache, the only update file outside `CARL_HOME`. Deleting the app folder and `CARL_HOME` removes the rest.
