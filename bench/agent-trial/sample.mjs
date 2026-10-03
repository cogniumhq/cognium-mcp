#!/usr/bin/env node
/**
 * The trial's sample: 30 Java targets drawn from the oracle labels, with the
 * caller set and the file set each prompt is graded against.
 *
 *   node bench/agent-trial/sample.mjs <labels.json> > sample.json
 *
 * Two limits of the grading key, stated here because every number downstream
 * inherits them:
 *
 *   1. **The labels are a 500-site sample of the repository, not a census.**
 *      So the oracle's caller set for a target is a LOWER BOUND. An agent that
 *      names a real caller the sample never drew is not wrong; it is
 *      off-sample, and the grader counts it separately rather than against it.
 *      This is the same off-sample denominator the evaluation pack defines.
 *   2. **Most in-tree targets have exactly one labelled caller.** Of 77, only
 *      17 have two or more. "List every caller" is therefore an easy question
 *      on much of this sample, and the sample is stratified by caller count so
 *      the report can say which half a result came from.
 */
import { readFileSync } from 'node:fs';

const PROJECT = /^(org\.owasp\.webgoat|org\.dummy)/;
const SEED = Number(process.env.SEED ?? 20261002);
const N = Number(process.env.N ?? 30);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const labels = Array.isArray(raw) ? raw : (raw.labels ?? raw.sites);

// In-tree: the oracle resolved the call AND the target is declared in the
// project's own namespace, so an index-based tool can answer about it at all.
const inTree = labels.filter((l) => l.target && PROJECT.test(l.target));

const byTarget = new Map();
for (const l of inTree) {
  if (!byTarget.has(l.target)) byTarget.set(l.target, []);
  byTarget.get(l.target).push(l);
}

// Stable order before sampling, so the seed alone reproduces the draw.
const targets = [...byTarget.keys()].sort();
const rnd = mulberry32(SEED);
const idx = [...targets.keys()];
for (let i = idx.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [idx[i], idx[j]] = [idx[j], idx[i]];
}

const sample = idx.slice(0, Math.min(N, idx.length)).sort((a, b) => a - b).map((i) => {
  const target = targets[i];
  const sites = byTarget.get(target);
  const files = [...new Set(sites.map((s) => s.site.file))].sort();
  return {
    target,
    // What "list every caller" is graded against: the sites the oracle knows.
    callers: sites
      .map((s) => ({ file: s.site.file, line: s.site.line, calleeName: s.site.text.split('.').pop() }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    // What "which files would change" is graded against: the files those sites are in.
    files,
    callerCount: sites.length,
    stratum: sites.length >= 2 ? 'multi-caller' : 'single-caller',
    receiverKinds: [...new Set(sites.map((s) => s.evidence?.receiverKind).filter(Boolean))].sort(),
  };
});

console.log(JSON.stringify({
  meta: {
    seed: SEED,
    size: sample.length,
    drawnFrom: { labelledSites: labels.length, resolvedInTree: inTree.length, distinctTargets: targets.length },
    strata: {
      'multi-caller': sample.filter((s) => s.stratum === 'multi-caller').length,
      'single-caller': sample.filter((s) => s.stratum === 'single-caller').length,
    },
    limits: [
      'the labels are a 500-site sample, so each caller set is a lower bound; an answer naming an unlabelled real caller is off-sample, not wrong',
      'most in-tree targets have one labelled caller, so the sample is stratified by caller count',
    ],
  },
  sample,
}, null, 1));
