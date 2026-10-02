# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

Node.js 20.19 or newer. The server package is `packages/mcp-server`; the plugin
is `plugins/cognium-dev` and has no build.

## What a change needs

- **Tests.** Coverage thresholds in `packages/mcp-server/vitest.config.ts` gate
  CI and only ratchet upward.
- **A changelog entry** in `packages/mcp-server/CHANGELOG.md` for anything a
  consumer could notice. If a consumer that does not adapt would get a wrong
  answer rather than an error, the entry needs a `Consumer Impact` section
  naming exactly what changes.
- **No tool removed, renamed or reshaped** without a major version. The
  `install` check in CI compares `tools/list` with the last release and fails on
  that.
- **Nothing model-specific in this package.** The server is deterministic.
  Anything that calls a model belongs in an optional tool module, which the
  server loads but never bundles.

## This repository is public

Do not add scan output, customer findings, tokens, private keys or `.env`
files. The pull request template has the checklist, and a CI check rejects
the obvious cases.
