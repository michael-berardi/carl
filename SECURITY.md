# Security

## Reporting

Report vulnerabilities privately through GitHub's security advisory form for this repository ("Report a vulnerability"). Please do not open a public issue for a security problem.

## What Carl protects

- **Who can talk to it:** only the user ids in each channel's `allowFrom`. Messages and button presses from anyone else are ignored and logged.
- **The API:** every route except the static web-app shell needs the bearer key, compared in constant time. The listener binds to loopback unless you change `api.host`. Webhooks need the key or a valid HMAC signature.
- **Carl's own files, secrets and your disk:** on macOS shell commands, MCP servers (except those listed in `trustedMcp`), the file tools, speech-to-text and command schedules run in a Seatbelt sandbox. The agent may write only its working areas, temp folders and folders you list; it cannot read or move credential files, launch apps, reach tmux or Docker, signal other processes, or call Carl's API. Those programs get an allowlisted environment, so Carl's tokens and keys exported in your shell never reach them. The README's Safety section has the full list.
- **Risky actions:** the guard asks the operator before destructive, publishing, deploying or app-automating commands, and refuses outright where nobody can be asked.
- **Billing:** the Claude route only forwards requests that authenticate with the subscription login (an OAuth token). It refuses API-key authentication rather than bill an API account.

## What it does not protect

Carl acts with the authority you give it. The sandbox does not limit the network or reading non-credential files. Trusted MCP servers act with your full permissions under their own policy; the guard asks before the ones that type into terminals or record your decisions (and any you add under `guard.askTools`), but their other tools, such as opening workers or queueing jobs, run without asking. The guard is a tripwire, not a proof. On macOS any program can read the startup environment of the user's other programs, so keep keys in files rather than exported shell variables. On Linux and Windows there is no kernel sandbox yet; Carl logs that at startup.
