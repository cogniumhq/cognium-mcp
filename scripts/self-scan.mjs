#!/usr/bin/env node
/**
 * Scan the server's own source with a published release of the scanner and
 * fail on any high or critical finding that is not a known false positive.
 *
 *   node scripts/self-scan.mjs [cli-spec]      default: $SELF_SCAN_CLI
 *
 * The scanner is a release from npm, never the engine this repository is
 * testing, so the product is not marking its own homework.
 *
 * KNOWN_FALSE_POSITIVES is the whole exception list, and it is held to
 * account in both directions: a finding that is not on it fails the job, and
 * an entry the scanner no longer reports fails the job too — so an exception
 * cannot outlive the defect it was written for.
 */

import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGET = 'packages/mcp-server/src';

/**
 * Releases of the scanner up to 4.9.29 parse `.ts` with the JavaScript
 * grammar (cogniumhq/cognium-dev#409). Type annotations then recover as
 * garbage, and a `Map` lookup in the cache — `this.entries.get(key)` — is
 * reported as SQL built from tainted data. There is no SQL in this package.
 * A scanner built from the fix reports nothing here. Remove this entry when
 * SELF_SCAN_CLI moves to a release that carries the fix; the job fails until
 * you do.
 */
export const KNOWN_FALSE_POSITIVES = [{ file: 'packages/mcp-server/src/cache.ts', type: 'sql_injection' }];

/** Sort findings into the ones to fail on and the exceptions that matched. */
export function classify(findings, known = KNOWN_FALSE_POSITIVES) {
  const unexpected = [];
  const matched = new Set();
  for (const finding of findings) {
    const index = known.findIndex((k) => k.file === finding.file && k.type === finding.type);
    if (index === -1) unexpected.push(finding);
    else matched.add(index);
  }
  const stale = known.filter((_, index) => !matched.has(index));
  return { unexpected, stale };
}

function scan(cli) {
  let stdout;
  try {
    stdout = execFileSync('npx', ['--yes', cli, 'scan', TARGET, '--severity', 'high', '-f', 'json', '-q'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // The scanner exits 1 when it finds something and still prints its report.
    if (typeof err.stdout !== 'string' || err.stdout.trim() === '') throw err;
    stdout = err.stdout;
  }
  const report = JSON.parse(stdout);
  const root = resolve('.');
  const findings = [];
  for (const result of report.results ?? []) {
    for (const v of result.vulnerabilities ?? []) {
      findings.push({ file: relative(root, result.file), type: v.type, severity: v.severity, line: v.line, message: v.message });
    }
  }
  return { findings, filesScanned: report.summary?.filesScanned ?? 0, version: report.version };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cli = process.argv[2] ?? process.env.SELF_SCAN_CLI;
  if (!cli) {
    console.error('self-scan: name the scanner release, e.g. cognium-dev@4.9.29, or set SELF_SCAN_CLI');
    process.exit(2);
  }
  const { findings, filesScanned, version } = scan(cli);
  console.log(`self-scan: ${cli} (reports ${version}) scanned ${filesScanned} files under ${TARGET}`);
  // A scan that looked at nothing is not a clean scan.
  if (filesScanned === 0) {
    console.error('self-scan: no file was scanned');
    process.exit(1);
  }

  const { unexpected, stale } = classify(findings);
  for (const f of findings.filter((x) => !unexpected.includes(x))) {
    console.log(`self-scan: known false positive — ${f.type} at ${f.file}:${f.line}`);
  }
  for (const f of unexpected) {
    console.error(`self-scan: ${f.severity} ${f.type} at ${f.file}:${f.line} — ${f.message}`);
  }
  for (const k of stale) {
    console.error(
      `self-scan: the exception for ${k.type} in ${k.file} no longer matches anything; remove it from KNOWN_FALSE_POSITIVES`,
    );
  }
  if (unexpected.length > 0 || stale.length > 0) process.exit(1);
  console.log('self-scan: no high or critical finding beyond the known false positives');
}
