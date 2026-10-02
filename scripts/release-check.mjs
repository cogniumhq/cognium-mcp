#!/usr/bin/env node
/**
 * The last step of `npm run release:check`: pack what is about to be
 * published, install it into an empty directory, and compare its tools with
 * the release already on npm.
 *
 * A removed or renamed tool, or a changed schema, stops the release here
 * unless the version being released is a new major — that is the one case
 * in which breaking the tool list is allowed, and it has to be on purpose.
 *
 * **That exemption is granted on an exit code, not on a failure.** It used to
 * be granted on any non-zero exit from `verify-install.mjs`, which has two
 * consequences, the second worse than the first: an install that could not
 * resolve a dependency was *reported* as a broken tool list, and on a major
 * release it was *excused* as one — so the gate passed without ever having
 * compared a tool list. A publish gate that passes because its check never
 * ran is worse than no gate. Only `EXIT.toolListBreaks` is excusable now;
 * everything else says what actually happened and fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT } from './verify-install.mjs';

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

  const verify = spawnSync(
    'node',
    ['scripts/verify-install.mjs', tarball, '--same-tools-as', `${manifest.name}@${published}`],
    { stdio: 'inherit', env },
  );

  if (verify.error) {
    console.error(`release check: could not run the install check — ${verify.error.message}`);
    process.exit(1);
  }

  switch (verify.status) {
    case EXIT.ok:
      break;

    case EXIT.toolListBreaks:
      // The one excusable failure, and only on a new major.
      if (major(manifest.version) > major(published)) {
        console.log(`release check: the tool list breaks, and ${manifest.version} is a new major — allowed`);
      } else {
        console.error(
          `release check: the tool list breaks and ${manifest.version} is not a new major over ${published}; ` +
            'restore the tool or schema, or release a major',
        );
        process.exit(1);
      }
      break;

    case EXIT.didNotInstall:
      console.error(
        'release check: a package did not INSTALL, so no tool list was compared. This is not a tool-list ' +
          'break and a new major does not excuse it. The commonest cause is a dependency this package pins ' +
          'that is not published yet — publish it first, run `npm ci`, and try again.',
      );
      process.exit(1);
      break;

    case EXIT.didNotServe:
      console.error(
        'release check: a package installed but did not SERVE, so no tool list was compared. This is not a ' +
          'tool-list break and a new major does not excuse it.',
      );
      process.exit(1);
      break;

    case EXIT.usage:
      console.error('release check: the install check was called wrongly — this is a bug in release-check.mjs');
      process.exit(1);
      break;

    default:
      console.error(`release check: the install check exited ${verify.status}, which this script does not know how to read`);
      process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
