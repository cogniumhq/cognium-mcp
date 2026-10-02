# Releasing `@cognium/mcp-server`

Publishing is done by hand, by a maintainer with npm access. Nothing in CI
publishes.

## Before

1. **Version** in `packages/mcp-server/package.json`, following the rule in the
   README: a removed or renamed tool or a changed schema is a major, a new tool
   or field is a minor, anything else a patch.
2. **Changelog entry** for that version, stating the `circle-ir` version it was
   tested against and, if one was used, the optional module version.
   `npm run check:pins` fails without it.
3. **`circle-ir` pin.** It is exact and moves only on purpose. Optional modules
   are refused at load when they were built against another minor, so a minor
   bump here has to be matched by a module release on the same minor.
4. **CI green on `main`**, including the `install` check, which compares the
   packed build's `tools/list` with the release on npm.

`npm run release:check` runs all of it locally: lint, the script tests, build,
typecheck, the suite with coverage thresholds, the pin check, and the packed
build against the release on npm. `npm publish` runs it too, through
`prepublishOnly`, and stops if any part fails. A removed or renamed tool, or a
changed schema, passes only when the version being released is a new major.

## Publish

```bash
npm ci
npm run build
cd packages/mcp-server
npm publish
```

`prepublishOnly` runs `release:check`, so a publish that would break a promise
in the README does not go out. Use `npm publish --dry-run` to see the result
without publishing.

## After

```bash
git tag mcp-server-v<version> <commit>
git push origin mcp-server-v<version>
```

Then check the published package the way a user gets it:

```bash
node scripts/verify-install.mjs @cognium/mcp-server@<version> --same-tools-as @cognium/mcp-server@<previous>
```

The registry can take a minute to show a new version; a 404 right after
publishing is not a failed publish.
