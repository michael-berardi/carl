# Security

## Reporting

Report vulnerabilities privately through GitHub's security advisory form for this repository ("Report a vulnerability"). Please do not open a public issue for a security problem.

## What Carl protects

- **Who can talk to it:** only the user ids in each channel's `allowFrom`. Messages and button presses from anyone else are ignored and logged.
- **The API:** every route except the static web-app shell needs the bearer key, compared in constant time. The listener binds to loopback unless you change `api.host`. Webhooks need the key or a valid HMAC signature.
- **Carl's own files and secrets:** on macOS every shell command runs in a Seatbelt sandbox that denies writes to `CARL_HOME` (except the agent's working areas) and reads of credential files. Carl's tokens and keys are removed from every command's environment.
- **Risky actions:** the guard asks the operator before destructive, publishing, deploying or app-automating commands, and refuses outright where nobody can be asked.
- **Billing:** the Claude route only forwards requests that authenticate with the subscription login (an OAuth token). It refuses API-key authentication rather than bill an API account.

## What it does not protect

Carl acts with the authority you give it. Tools that start workers, call MCP servers or drive other programs can do whatever those can do. The guard is a tripwire, not a sandbox for those routes. On Linux and Windows there is no kernel sandbox yet; Carl logs that at startup.
