# Contributing

Keep Carl small: a change should earn its lines. New integrations belong in modules (`src/channels/`, `src/compat/`, Pi extensions), not in the core.

```sh
npm ci
npm run verify                         # typecheck + unit tests
npm run test:e2e                       # full gateway against a fake Telegram (needs a model login)
node --experimental-strip-types test/slack.e2e.ts
node --experimental-strip-types test/discord.e2e.ts
```

End-to-end tests use your real model login; set `CARL_E2E_MODEL` (for example `claude-code/claude-sonnet-5-5`) to pick the model. Errors must name their cause, and behaviour changes update the README in the same commit.
