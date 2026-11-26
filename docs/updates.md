<!-- update-contract: v1 -->

# Updates

Carl tells you when a newer release is out and installs it in one step. It never installs on its own unless you turn automatic installs on.

## The check

Once a day Carl asks GitHub for the latest release of the repository named in its `package.json`: one anonymous `GET /repos/<owner>/<repo>/releases/latest` with `User-Agent: carl-update-check`, no identifier, no version, no usage or machine data. Only stable `x.y.z` releases count; drafts, prereleases and anything unparseable are ignored.

The answer is cached for 24 hours in one file, `update-check.json` in `~/Library/Caches/carl` (macOS) or `$XDG_CACHE_HOME/carl` (else `~/.cache/carl`), written atomically with mode 600. A failed check is cached with its cause and not retried until the next day; `carl update --check` shows the cause.

Checks are off with `CARL_NO_UPDATE_CHECK=1`, `CARL_OFFLINE=1` or `"update": {"check": false}` in `carl.json` (the web app's "Check for updates automatically" switch).

## Terminal

After a command, on a terminal, Carl prints two lines on stderr, at most once a day per version:

```
carl 0.20.0 available (you have 0.19.0) · run: carl update
turn on automatic updates: carl update --auto on · skip: carl update --skip
```

The check runs while the command runs, so it never delays it. Nothing is printed when stdout or stderr is not a terminal, in CI, in an agent session (Claude Code, Codex, Gemini CLI), with `--json`, or after an opt-out.

- `carl update` shows the current and new version with the first lines of the release notes, asks `Install 0.20.0 now? [Y/n]`, and installs. Without a terminal it installs without asking. After the first successful install it asks once `Install future updates automatically? [y/N]`; a "no" is never asked again.
- `carl update --check` only reports. Exit code `0`: up to date, `10`: an update is available, `1`: the check failed (the cause is printed). It uses the day's cached answer; add `--refresh` to ask GitHub again.
- `carl update --skip` hides this version's notices. A newer release notifies again.
- `carl update --auto on|off|status` turns automatic installs on or off (stored as `"update": {"auto": true}` in `carl.json`, every other setting kept) or reports the setting.
- `carl update --rollback` goes back to the previous release.

## Telegram and the web app

The gateway checks on its own daily timer, never at startup, and sends the home chat the release notes with **Update now**, **Skip this version** and, while automatic installs are off, **Turn on automatic updates**. If the buttons cannot be sent, the message lists `/update`, `/update skip` and `/update auto on` instead; `/update check` reports without installing.

The web app's Status page shows a banner with **Install Update**, **Remind Me Later** (hides it for a day) and **Skip This Version**, the release notes, and an unchecked **Automatically download and install updates in the future** box. Below it, the Updates rows: "Check for updates automatically" (on by default), "Install updates automatically" (off by default), then the current version with **Check Now**.

## Automatic installs

Off by default. When on, the gateway's daily check installs a new release in a low-priority child process while the gateway keeps answering, then restarts on it once nothing is running. While runs are active it tries again in ten minutes. A failed install keeps the current version running, records the cause and sends the normal notice instead. Background installs log to `CARL_HOME/logs/auto-update.log`, one file kept under 256 KB.

The gateway keeps its own next-check time: `carl update --check`, `/update` and restarts do not postpone it.

## Install safety

- **Release folder** (the installer's layout, `<app>/current -> <app>/release-<version>-<commit>`): Carl downloads the release's `carl.tar.gz` and `SHA256SUMS` and refuses the download unless its SHA-256 matches. It unpacks beside the current release, installs dependencies, checks that the new copy starts and reports the right version, then swaps the `current` link atomically. Any failure leaves the current release and link untouched and removes the download folder.
- **Git checkout**: fast-forwards to the release tag, then `npm ci --omit=dev`. It refuses a checkout with local changes and prints a recovery command when history was rewritten.
- Two bots sharing one app folder share a release: the second one to update links the release folder the first installed.

The previous release stays as `current.previous` for `carl update --rollback`. It is removed after the new version has run once (or after seven days at most), unless another bot still uses that folder. Older release folders no link uses are removed at each install.

## Uninstall

`carl update --auto off` removes the check cache, the only update file outside `CARL_HOME`. Then delete the app folder and `CARL_HOME`. See [PRIVACY.md](../PRIVACY.md) for every file and request.
