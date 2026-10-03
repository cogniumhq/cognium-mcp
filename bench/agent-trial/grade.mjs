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

/** A count the answer claims in prose, e.g. "246 call sites across 109 files". */
function claimedFileCount(text) {
  const m = /(\d+)\s+files?/i.exec(String(text));
  return m ? Number(m[1]) : null;
}

function grade(run) {
  const site = byTarget.get(run.target);
  const expected = new Set(site.files);
  const named = filesIn(run.answer);
  const hit = [...expected].filter((f) => named.has(f));
  const offSample = [...named].filter((f) => !expected.has(f));
  const claimed = claimedFileCount(run.answer);

  // `unscoreable`, not `wrong`.
  //
  // Both prompts are open questions and the answers come back as prose. An
  // agent that replies "246 call sites across 109 files, all under
  // src/main/java/org/owasp/webgoat/lessons/" has answered well and named no
  // path this grader can match against a file set — and on this sample that
  // is the COMMON case for a target with many callers. Calling it `wrong`
  // would turn a limitation of the grading key into a finding about the
  // subject, which is the one thing a bench must not do. Graded `wrong` only
  // when the answer does enumerate paths and none of them is expected.
  let verdict;
  if (!run.ok) verdict = 'error';
  else if (named.size === 0) verdict = 'unscoreable:no-path-named';
  else if (hit.length === expected.size) verdict = 'correct';
  else if (hit.length > 0) verdict = 'partial';
  else if (claimed !== null && claimed > expected.size) verdict = 'unscoreable:summarised-a-larger-set';
  else verdict = 'wrong';

  return {
    ...run,
    stratum: site.stratum,
    expectedFiles: expected.size,
    hitFiles: hit.length,
    offSampleFiles: offSample.length,
    namedAnyPath: named.size > 0,
    claimedFileCount: claimed,
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

/** Only a scoreable pair contributes a delta; the rest are counted, not scored. */
const score = (v) => (v === 'correct' ? 1 : v === 'partial' ? 0.5 : v === 'wrong' ? 0 : null);

/**
 * Paired by (target, kind, harness, repeat): the same question, baseline and
 * one MCP arm. Phase 7 has three MCP arms rather than one, so a pair carries
 * the `variant` it belongs to and every summary is reported per variant. The
 * Phase 6 shape read `config === 'with-mcp'`; against a four-arm run that
 * matched nothing and silently produced zero pairs.
 */
const pairs = [];
const key = (r) => `${r.harness}|${r.kind}|${r.target}|${r.repeat}`;
const variantOf = (r) => r.variant ?? r.config;
const base = new Map(graded.filter((r) => variantOf(r) === 'baseline').map((r) => [key(r), r]));
for (const w of graded.filter((r) => variantOf(r) !== 'baseline')) {
  const b = base.get(key(w));
  if (!b) continue;
  const scoreable = score(w.verdict) !== null && score(b.verdict) !== null;
  pairs.push({
    scoreable,
    variant: variantOf(w),
    harness: w.harness, kind: w.kind, target: w.target, repeat: w.repeat, stratum: w.stratum,
    dScore: scoreable ? score(w.verdict) - score(b.verdict) : null,
    dTokensIn: w.tokensIn - b.tokensIn,
    dTokensOut: w.tokensOut - b.tokensOut,
    dWallMs: w.wallMs - b.wallMs,
    dCostUsd: (w.costUsd ?? 0) - (b.costUsd ?? 0),
    baseline: { verdict: b.verdict, tokensIn: b.tokensIn, tokensOut: b.tokensOut, wallMs: b.wallMs },
    withMcp: { verdict: w.verdict, tokensIn: w.tokensIn, tokensOut: w.tokensOut, wallMs: w.wallMs, usedFindCallers: w.usedFindCallers },
  });
}

function summarise(rows, label) {
  return {
    label,
    pairs: rows.length,
    scoreablePairs: rows.filter((r) => r.scoreable).length,
    dScore: meanCi(rows.filter((r) => r.scoreable).map((r) => r.dScore)),
    dTokensIn: meanCi(rows.map((r) => r.dTokensIn)),
    dTokensOut: meanCi(rows.map((r) => r.dTokensOut)),
    dWallSeconds: meanCi(rows.map((r) => r.dWallMs / 1000)),
    dCostUsd: meanCi(rows.map((r) => r.dCostUsd)),
    toolSelection: {
      called: rows.filter((r) => r.withMcp.usedFindCallers).length,
      n: rows.length,
      rate: rows.length ? rows.filter((r) => r.withMcp.usedFindCallers).length / rows.length : null,
    },
  };
}

const harnesses = [...new Set(pairs.map((p) => p.harness))];
const kinds = [...new Set(pairs.map((p) => p.kind))];
const variants = [...new Set(pairs.map((p) => p.variant))];

/**
 * The headline the phase asked for: tool-selection rate per variant per
 * harness, computed over the MCP-arm RUNS and not over pairs, so a missing
 * baseline could never quietly shrink a denominator. A harness that cannot
 * carry a variant at all is reported as not applicable, which is a different
 * fact from a rate of zero.
 */
const CANNOT_CARRY = { codex: ['hooked'] };
const toolSelection = harnesses.flatMap((h) => variants.map((v) => {
  if ((CANNOT_CARRY[h] ?? []).includes(v)) {
    return { harness: h, variant: v, applicable: false, reason: 'the harness has no hook mechanism', called: null, n: 0, rate: null };
  }
  const rows = graded.filter((r) => r.harness === h && variantOf(r) === v);
  return {
    harness: h, variant: v, applicable: true,
    called: rows.filter((r) => r.usedFindCallers).length,
    n: rows.length,
    rate: rows.length ? rows.filter((r) => r.usedFindCallers).length / rows.length : null,
  };
}));

console.log(JSON.stringify({
  meta: {
    ...results.meta,
    grading: 'recall against the labelled callers; off-sample names are counted, never penalised',
    provenance: 'reasoned from a bench — a paired agent trial, not a graded pack run',
  },
  toolSelection,
  overall: summarise(pairs, 'all pairs'),
  byVariant: variants.map((v) => summarise(pairs.filter((p) => p.variant === v), v)),
  byVariantAndHarness: variants.flatMap((v) => harnesses.map((h) =>
    summarise(pairs.filter((p) => p.variant === v && p.harness === h), `${v} · ${h}`))),
  byHarness: harnesses.map((h) => summarise(pairs.filter((p) => p.harness === h), h)),
  byPrompt: kinds.map((k) => summarise(pairs.filter((p) => p.kind === k), k)),
  byHarnessAndPrompt: harnesses.flatMap((h) => kinds.map((k) =>
    summarise(pairs.filter((p) => p.harness === h && p.kind === k), `${h} · ${k}`))),
  verdictCounts: Object.fromEntries(
    [...new Set(graded.map((r) => r.verdict))].sort().map((v) => [v, graded.filter((r) => r.verdict === v).length]),
  ),
  pairs,
  runs: graded,
}, null, 1));
