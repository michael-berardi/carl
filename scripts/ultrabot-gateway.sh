#!/bin/zsh -f
# UltraBot slot -> Carl. UltraTerm runs this file in custom mode; `exec` keeps one pid (UltraTerm checks it).
# Carl: ~/.carl (config carl.json, persona in psyche/), release ~/.carl/app/current, deploy ~/.carl/scripts/deploy.sh.
# Rollback to Hermes: restore ~/.hermes/backups/carl-cutover-*/ultrabot-gateway.sh and restart UltraBot in UltraTerm.
#
# Carl starts from a clean environment: only terminal, locale and UltraTerm identity variables pass, never anything
# that looks like a credential (on macOS any program of this user can read another's startup environment).
# Its own secrets come from files (~/.hermes/.env), which its sandbox keeps from the agent.
keep=(HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL=/bin/zsh CARL_HOME="$HOME/.carl"
  PATH="$HOME/.ultraterm/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
for line in "${(@f)$(/usr/bin/env)}"; do
  name=${line%%=*}
  [[ $name =~ '(KEY|TOKEN|SECRET|PASSW|AUTH|CRED|COOKIE|SESSION)' ]] && continue
  [[ $name =~ '^(ULTRATERM_|UT_UPDATE_|LC_|OVERSEER_)' || $name =~ '^(TMUX|TMUX_PANE|TMUX_BIN|TERM|TERM_PROGRAM|TERMINFO_DIRS|COLORTERM|LANG|TZ|TMPDIR)$' ]] && keep+=("$line")
done
cd "$HOME"
echo "Carl gateway starting $(/bin/date)"
exec /usr/bin/env -i "${keep[@]}" "$HOME/.carl/app/current/bin/carl" gateway
