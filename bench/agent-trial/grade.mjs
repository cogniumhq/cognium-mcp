#!/usr/bin/env node
/**
 * Grading, and the paired deltas.
 *
 *   node bench/agent-trial/grade.mjs results.json sample.json > graded.json
 *
 * **What correct means here, and what it cannot mean.** The oracle labels are a
 * 500-site sample of the repository, so the caller set for a target is a LOWER
 * BOUND, not a census. A run that names a real caller the sample never drew is
 * not wrong — it is off-sample. So the grade is **recall against the labelled
 * callers**, and names outside the label set are counted and reported but never
 * held against a run:
 *
 *   correct  every labelled caller's file is named
 *   partial  some but not all
 *   wrong    none
 *
 * That makes this a measure of whether a run finds what the compiler found. It
 * is not a precision measure, and nothing here should be read as one: a run
 * that listed every file in the repository would score `correct` and is caught
 * only by the off-sample count beside it.
 *
 * The file set is the unit for both prompts. A caller answer that names the
 * right files but mangles a line number is still the useful answer, and line
 * numbers drift with any edit; the impact prompt asks for files outright.
 */
import { readFileSync } from 'node:fs';

const results = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sample = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const byTarget = new Map(sample.sample.map((s) => [s.target, s]));

/** Every path-looking token in a free-text answer, normalised. */
function filesIn(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/[\w./-]*src\/[\w./-]+\.java/g)) {
    found.add(m[0].replace(/^.*?(src\/)/, '$1'));
  }
  // A bare class name counts only when the answer gives no path at all, which
  // is reported rather than silently credited.
  return found;
}

function grade(run) {
  const site = byTarget.get(run.target);
  const expected = new Set(site.files);
  const named = filesIn(run.answer);
  const hit = [...expected].filter((f) => named.has(f));
  const offSample = [...named].filter((f) => !expected.has(f));
  const verdict = !run.ok ? 'error' : hit.length === expected.size ? 'correct' : hit.length > 0 ? 'partial' : 'wrong';
  return {
    ...run,
    stratum: site.stratum,
    expectedFiles: expected.size,
    hitFiles: hit.length,
    offSampleFiles: offSample.length,
    namedAnyPath: named.size > 0,
    verdict,
  };
}

const graded = results.runs.map(grade);

/** Mean, and a Student-t 95 % interval. Small n, so t and not z. */
function meanCi(xs) {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, ci: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, ci: null };
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  // t for 95 % two-sided, by df; beyond 30 the normal value is close enough.
  const T = [12.71, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  const t = T[Math.min(n - 2, T.length - 1)];
  const half = t * (sd / Math.sqrt(n));
  return { n, mean, sd, ci: [mean - half, mean + half] };
}

const score = (v) => (v === 'correct' ? 1 : v === 'partial' ? 0.5 : 0);

/** Paired by (target, kind, harness, repeat): the same question, both arms. */
const pairs = [];
const key = (r) => `${r.harness}|${r.kind}|${r.target}|${r.repeat}`;
const base = new Map(graded.filter((r) => r.config === 'baseline').map((r) => [key(r), r]));
for (const w of graded.filter((r) => r.config === 'with-mcp')) {
  const b = base.get(key(w));
  if (!b) continue;
  pairs.push({
    harness: w.harness, kind: w.kind, target: w.target, repeat: w.repeat, stratum: w.stratum,
    dScore: score(w.verdict) - score(b.verdict),
    dTokensIn: w.tokensIn - b.tokensIn,
    dTokensOut: w.tokensOut - b.tokensOut,
    dWallMs: w.wallMs - b.wallMs,
    baseline: { verdict: b.verdict, tokensIn: b.tokensIn, tokensOut: b.tokensOut, wallMs: b.wallMs },
    withMcp: { verdict: w.verdict, tokensIn: w.tokensIn, tokensOut: w.tokensOut, wallMs: w.wallMs, usedFindCallers: w.usedFindCallers },
  });
}

function summarise(rows, label) {
  return {
    label,
    pairs: rows.length,
    dScore: meanCi(rows.map((r) => r.dScore)),
    dTokensIn: meanCi(rows.map((r) => r.dTokensIn)),
    dTokensOut: meanCi(rows.map((r) => r.dTokensOut)),
    dWallSeconds: meanCi(rows.map((r) => r.dWallMs / 1000)),
    toolSelectionRate: rows.length ? rows.filter((r) => r.withMcp.usedFindCallers).length / rows.length : null,
  };
}

const harnesses = [...new Set(pairs.map((p) => p.harness))];
const kinds = [...new Set(pairs.map((p) => p.kind))];

console.log(JSON.stringify({
  meta: {
    ...results.meta,
    grading: 'recall against the labelled callers; off-sample names are counted, never penalised',
    provenance: 'reasoned from a bench — a paired agent trial, not a graded pack run',
  },
  overall: summarise(pairs, 'all pairs'),
  byHarness: harnesses.map((h) => summarise(pairs.filter((p) => p.harness === h), h)),
  byPrompt: kinds.map((k) => summarise(pairs.filter((p) => p.kind === k), k)),
  byHarnessAndPrompt: harnesses.flatMap((h) => kinds.map((k) =>
    summarise(pairs.filter((p) => p.harness === h && p.kind === k), `${h} · ${k}`))),
  verdictCounts: Object.fromEntries(['correct', 'partial', 'wrong', 'error'].map((v) => [v, graded.filter((r) => r.verdict === v).length])),
  pairs,
  runs: graded,
}, null, 1));
