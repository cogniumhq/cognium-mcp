/**
 * Output schemas for the tools whose answers were text only until 0.8.0
 * (issue #38). Each is the tool's envelope: the top-level fields it always
 * or sometimes returns, typed loosely below that, so a client (and the SDK)
 * can validate the shape without the server freezing every nested field of
 * the engine's facts. `structuredContent` carries the same object as the
 * JSON text (`textResult` builds both from one serialisation).
 *
 * Typing rule: a field the tool always sets is required; a field it sets on
 * some answers only is optional. Nested engine objects are passthrough
 * objects: their shape is the engine's, documented in C4 and the engine's
 * own schemes, and may gain fields in a minor.
 */

import { z } from 'zod';

const obj = z.object({}).passthrough();
const objs = z.array(obj);
const counts = z.record(z.string(), z.number());
const provenance = z.string();

export const scanOutputShape = {
  projectRoot: z.string(),
  scannedPath: z.string(),
  fileCount: z.number(),
  cacheHit: z.boolean(),
  analysisMs: z.number(),
  crossFileBudgetExceeded: z.boolean(),
  summary: obj,
  findings: objs,
  findingsTruncated: z.boolean(),
  taintFlows: objs,
  taintFlowsTruncated: z.boolean(),
  crossFileTaintPaths: objs,
  crossFileTaintPathsTruncated: z.boolean(),
  note: z.string().optional(),
  _limits: obj,
  provenance,
} as const;

export const explainFindingOutputShape = {
  finding: obj,
  rule: obj,
  provenance,
} as const;

export const taintPathsOutputShape = {
  projectRoot: z.string(),
  cacheHit: z.boolean(),
  analysisMs: z.number(),
  crossFileBudgetExceeded: z.boolean(),
  totalMatching: z.number(),
  truncated: z.boolean(),
  paths: objs,
  provenance,
} as const;

export const listEntryPointsOutputShape = {
  projectRoot: z.string(),
  cacheHit: z.boolean(),
  totalEntryPoints: z.number(),
  truncated: z.boolean(),
  byFramework: counts,
  byLanguage: counts,
  byKind: counts,
  entryPoints: objs,
  provenance,
} as const;

export const checkSanitizerOutputShape = {
  isValidSanitizer: z.boolean(),
  function: z.string(),
  sink_type: z.string(),
  language: z.string(),
  notes: z.string(),
  matchedRules: objs.optional(),
  alternatives: z.array(z.unknown()).optional(),
  provenance,
} as const;

export const describeSinkOutputShape = {
  sink_type: z.string(),
  cwe: z.unknown(),
  name: z.unknown(),
  shortDescription: z.unknown(),
  fullDescription: z.unknown(),
  remediation: z.unknown(),
  cvssScore: z.unknown(),
  severityLevel: z.unknown(),
  language: z.string(),
  sanitizers: z.array(z.string()),
  sanitizerCount: z.number(),
  provenance,
} as const;

export const describeSourceOutputShape = {
  source_type: z.string(),
  language: z.string(),
  totalPatterns: z.number(),
  patterns: objs,
  truncated: z.boolean(),
  provenance,
} as const;

export const attackSurfaceSummaryOutputShape = {
  projectRoot: z.string(),
  cacheHit: z.boolean(),
  totals: obj,
  entryPoints: obj,
  sinks: obj,
  findings: obj,
  crossFileTaintPaths: obj,
  topFiles: z.array(z.unknown()),
  provenance,
} as const;

export const listReachableSinksOutputShape = {
  projectRoot: z.string(),
  cacheHit: z.boolean(),
  filters: obj,
  totalReachable: z.number(),
  truncated: z.boolean(),
  bySinkType: counts,
  byLanguage: counts,
  sinks: objs,
  provenance,
} as const;

export const findSimilarOutputShape = {
  projectRoot: z.string(),
  cacheHit: z.boolean(),
  anchor: obj,
  matchBy: z.unknown(),
  totalMatches: z.number(),
  truncated: z.boolean(),
  similar: objs,
  provenance,
} as const;

/**
 * `find_callers` / `find_callees`: the envelope is the tool's, the answer
 * fields are the engine's navigation answer spread through unchanged, so
 * only the envelope is required here.
 */
export const navigationOutputFields = {
  projectRoot: z.string(),
  cacheHit: z.boolean(),
  resolvedSymbol: z.unknown().optional(),
  query: obj.optional(),
  answers: z.array(z.unknown()).optional(),
  unresolved: z.array(z.unknown()).optional(),
  scope: obj.optional(),
  nextStep: z.string().optional(),
  provenance,
} as const;

/** Open to further fields: the engine's answer may gain one in a minor. */
export const navigationOutputShape = z.object(navigationOutputFields).passthrough();

export const refreshOutputShape = {
  projectRoot: z.string().optional(),
  cleared: z.literal('all').optional(),
  entriesRemoved: z.number(),
  cacheSizeAfter: z.number(),
  provenance,
} as const;
