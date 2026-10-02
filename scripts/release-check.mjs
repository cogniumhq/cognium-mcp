#!/usr/bin/env node
/**
 * The last step of `npm run release:check`: pack what is about to be
 * published, install it into an empty directory, and compare its tools with
 * the release already on npm.
 *
 * A removed or renamed tool, or a changed schema, stops the release here
 * unless the version being released is a new major — that is the one case
 * in which breaking the tool list is allowed, and it has to be on purpose.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This runs from `prepublishOnly`, so under `npm publish --dry-run` npm hands
// its dry-run setting down to every npm it starts. The pack and the installs
// here have to be real for the check to mean anything, dry run or not.
const env = { ...process.env };
delete env.npm_config_dry_run;

const manifest = JSON.parse(readFileSync('packages/mcp-server/package.json', 'utf8'));
const published = execFileSync('npm', ['view', manifest.name, 'version'], { encoding: 'utf8', env }).trim();
const major = (version) => Number(version.split('.')[0]);

const dir = mkdtempSync(join(tmpdir(), 'release-check-'));
try {
  execFileSync('npm', ['pack', '--workspace', 'packages/mcp-server', '--pack-destination', dir], {
    stdio: 'ignore',
    env,
  });
  const tarball = join(dir, readdirSync(dir).find((name) => name.endsWith('.tgz')));
  console.log(`release check: ${manifest.name} ${manifest.version} against ${published} on npm`);

  if (manifest.version === published) {
    console.error(`release check: ${manifest.version} is already published; bump the version first`);
    process.exit(1);
  }

  try {
    execFileSync('node', ['scripts/verify-install.mjs', tarball, '--same-tools-as', `${manifest.name}@${published}`], {
      stdio: 'inherit',
      env,
    });
  } catch {
    if (major(manifest.version) > major(published)) {
      console.log(`release check: the tool list breaks, and ${manifest.version} is a new major — allowed`);
    } else {
      console.error(
        `release check: the tool list breaks and ${manifest.version} is not a new major over ${published}; ` +
          'restore the tool or schema, or release a major',
      );
      process.exit(1);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
