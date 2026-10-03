/**
 * `find_callers` and `find_callees` — who calls a method, and what a method
 * calls, with every answer saying how it was reached.
 *
 * These two differ from the other nine read-only tools in what they promise.
 * A scan reports what it found; these report what they found **and what they
 * could not reach**, because a caller list is only useful if you know whether
 * it is complete. So every response carries three things the engine computes
 * and this tool passes through untouched:
 *
 *   - a **tier** per answer. `exact` means the receiver's static type was
 *     known and the target was unique in it. `polymorphic` means dispatch is
 *     open, with every candidate body listed. `inferred` means bound by name
 *     alone — a floor, never a promise, and never produced when a receiver
 *     type *is* known and disagrees.
 *   - a **reason** per non-answer, from a closed vocabulary, so "7,000 sites
 *     unresolved" can be read as "6,900 of them are in the JDK".
 *   - a **scope**: how many files were searched, in which languages, and what
 *     was deliberately left out. A count without its denominator is not an
 *     answer.
 *
 * The envelope this tool adds around that — `projectRoot`, `cacheHit`,
 * `nextStep`, `provenance` — is the server's. The answer-shape fields inside
 * are the engine's and are not rewritten here, because they are compared
 * field for field against a compiler-backed oracle.
 */

import { z } from 'zod';
import { resolve } from 'path';
import type { NavigationAnswer, Tier } from 'circle-ir';
import type { ToolContext, ToolResult } from './types.js';
import { textResult, errorResult, READ_ONLY_ANNOTATIONS } from './types.js';

/** Cap on `answers[]`. A truncated list always says so. */
export const MAX_NAVIGATION_ANSWERS = 200;

const TIERS = ['exact', 'polymorphic', 'inferred'] as const;

const LANGUAGES = [
  'java', 'javascript', 'typescript', 'python', 'go', 'rust', 'bash', 'html',
] as const;

/**
 * Either a symbol or a site, never both.
 *
 * The site form is keyed on `(file, line, method_name)` and not on a column,
 * because a chained expression reports several calls at one line and column —
 * `b.of().step("a").done()` is three calls at one position — so a
 * `(file, line, col)` triple cannot address one of them. The method name is
 * what completes the key.
 */
const commonShape = {
  project_root: z.string().describe('Absolute path to the project root.'),
  symbol: z
    .string()
    .optional()
    .describe(
      'Fully-qualified name, e.g. `com.acme.users.User.equals`. A constructor is ' +
        '`com.acme.users.User.<init>`. Give this or `site`, not both.',
    ),
  site: z
    .object({
      file: z.string().describe('Path relative to the project root.'),
      line: z.number().int().positive().describe('1-indexed line.'),
      method_name: z
        .string()
        .describe(
          'The method name as written on that line. Required because one line and ' +
            'column can hold several calls in a chained expression.',
        ),
    })
    .optional()
    .describe('A call site, when you have a line of code rather than a name.'),
  language: z.enum(LANGUAGES).optional().describe('Restrict the search to one language.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe(`Cap on returned answers (default ${MAX_NAVIGATION_ANSWERS}). Truncation is reported.`),
  tiers: z
    .array(z.enum(TIERS))
    .optional()
    .describe('Return only these tiers. Omit for all three. `["exact"]` for answers you can act on.'),
} as const;

export const findCallersInputShape = commonShape;
export const findCalleesInputShape = commonShape;

export const findCallersConfig = {
  title: 'Find the callers of a symbol',
  description:
    // The first line answers "which question is this tool for?", because an
    // agent choosing between grep and a call graph is choosing between two
    // tools that both look applicable. Measured on a paired bench, the tool
    // was reached for on 1 of 12 runs where it was available and the question
    // was exactly this one; this text is the cheapest thing to change.
    'THE QUESTION THIS ANSWERS: "who calls this method?" — call this FIRST for that question, ' +
    'before grepping. A text search for a method name finds the name; this finds the calls, and ' +
    'says which ones it is sure of.\n\n' +
    'Who calls this method, with a resolution tier on every answer and a reason on every site it ' +
    'could not resolve. Use it before changing or deleting a method, to see what depends on it, and ' +
    'to judge the blast radius of a rename.\n\n' +
    'Read the tiers before acting: `exact` means the receiver\'s static type was known and the target ' +
    'was unique in it — act on these. `polymorphic` means dispatch is open; `candidates` lists every ' +
    'implementation that could run, and all of them are reachable. `inferred` means bound by the ' +
    'method name alone with no receiver type to confirm it — treat it as a lead to check, never as a ' +
    'caller. An inferred hit is NOT evidence that the method is called from there.\n\n' +
    '`unresolved` is the honest half of the answer: each entry is a site that calls something of this ' +
    'name which could not be bound, with a reason — `external` (the target is outside the searched ' +
    'tree, e.g. in the JDK or a framework), `dynamic` (reflection), `generated` (the member only ' +
    'exists after annotation processing, e.g. a Lombok accessor), `parse-error`, ' +
    '`unsupported-language`, or `unknown` (in the tree, and we failed to bind it). ' +
    'A large `external` count usually means the name is a common one, not that the answer is poor.\n\n' +
    '`scope` states what was searched and what was skipped, so a count can be read against its ' +
    'denominator. Deterministic: no model is consulted.',
  inputSchema: findCallersInputShape,
  annotations: READ_ONLY_ANNOTATIONS,
} as const;

export const findCalleesConfig = {
  title: 'Find what a symbol calls',
  description:
    'THE QUESTION THIS ANSWERS: "what does this method call?" — call this FIRST for that question, ' +
    'before reading the body and following names by hand.\n\n' +
    'What this method calls, with a resolution tier on every answer and a reason on every call it ' +
    'could not resolve. Use it to understand a method before editing it, to trace what a change will ' +
    'touch, and to find the project-internal calls inside a body full of framework noise.\n\n' +
    'Tiers and `unresolved` mean exactly what they do for `find_callers` — `exact` is actionable, ' +
    '`polymorphic` lists every candidate body, `inferred` is a lead and not a fact. In a typical ' +
    'method body most unresolved entries are `external`: calls into the standard library and ' +
    'frameworks, which are correctly not answered rather than missing.\n\n' +
    'A constructor appears as a target ending `.<init>`, while `methodName` is the name as written ' +
    'at the call site, so the two differ for a `new` expression. Deterministic: no model is consulted.',
  inputSchema: findCalleesInputShape,
  annotations: READ_ONLY_ANNOTATIONS,
} as const;

interface NavigationArgs {
  project_root: string;
  symbol?: string;
  site?: { file: string; line: number; method_name: string };
  language?: (typeof LANGUAGES)[number];
  limit?: number;
  tiers?: Tier[];
}

/**
 * What to do when nothing is `exact`.
 *
 * The engine deliberately has no field for this: the answer shape is compared
 * field for field against an oracle, and a hint is advice rather than a fact
 * about the code. So it is computed here, from the answer the engine gave,
 * and lives in the server's envelope.
 */
export function nextStepFor(answer: NavigationAnswer, kind: 'callers' | 'callees'): string | undefined {
  const exact = answer.answers.filter((a) => a.tier === 'exact').length;
  if (exact > 0) return undefined;

  const polymorphic = answer.answers.filter((a) => a.tier === 'polymorphic').length;
  if (polymorphic > 0) {
    return (
      `No answer is exact. ${polymorphic} ${plural(polymorphic, 'site', 'sites')} dispatch openly — ` +
      'read `candidates` on each and decide which implementations matter, rather than assuming one.'
    );
  }

  const inferred = answer.answers.filter((a) => a.tier === 'inferred').length;
  const reasons = tally(answer.unresolved.map((u) => u.reason));
  const unknown = reasons.unknown ?? 0;
  const external = reasons.external ?? 0;

  if (inferred > 0) {
    return (
      `No answer is exact: ${inferred} ${plural(inferred, 'hit is', 'hits are')} bound by method name ` +
      'alone. Open each site and check the receiver before relying on it, or narrow the query to the ' +
      'declaring type. A language server with full type information will do better here than this ' +
      'call graph can.'
    );
  }
  if (unknown > 0) {
    return (
      `Nothing resolved, and ${unknown} ${plural(unknown, 'site is', 'sites are')} in the searched tree ` +
      'but could not be bound — this call graph is insufficient for them. Try a language server, or ' +
      'grep for the name and read the receivers.'
    );
  }
  if (external > 0 && answer.answers.length === 0) {
    return (
      `Nothing resolved inside the searched tree: ${external} of the ` +
      `${answer.unresolved.length} ${plural(answer.unresolved.length, 'site', 'sites')} target code ` +
      'outside it. If you expected a project target, check `scope` — the file may be in an excluded ' +
      'directory, or the symbol may be spelled differently.'
    );
  }
  if (answer.answers.length === 0 && answer.unresolved.length === 0) {
    return (
      `No ${kind} found at all. Check the symbol is fully qualified and spelled as the project ` +
      'declares it, and that `scope.searched.files` is the number of files you expected.'
    );
  }
  return undefined;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function makeHandler(kind: 'callers' | 'callees') {
  return (ctx: ToolContext) =>
    async (args: NavigationArgs): Promise<ToolResult> => {
      if (!args.symbol && !args.site) {
        return errorResult('give either `symbol` or `site`.');
      }
      if (args.symbol && args.site) {
        return errorResult('give `symbol` or `site`, not both.');
      }

      const root = resolve(args.project_root);
      const { index, cacheHit, fileCount } = await ctx.cache.getOrComputeNavigation(root, {
        ...(args.language ? { language: args.language } : {}),
      });

      let symbol = args.symbol;
      if (args.site) {
        symbol = index.symbolAt(args.site.file, args.site.line, args.site.method_name, kind);
        if (!symbol) {
          return textResult({
            projectRoot: root,
            cacheHit,
            query: { kind, site: args.site },
            resolvedSymbol: null,
            answers: [],
            unresolved: [],
            nextStep:
              `No call to \`${args.site.method_name}\` was found at ${args.site.file}:${args.site.line}, ` +
              'or the call could not be bound to a symbol to search for. Check the file path is relative ' +
              `to the project root (${fileCount} files were indexed) and that the name is as written.`,
          });
        }
      }

      const opts = {
        limit: args.limit ?? MAX_NAVIGATION_ANSWERS,
        ...(args.tiers ? { tiers: args.tiers } : {}),
      };
      const answer =
        kind === 'callers'
          ? index.resolveCallers({ symbol: symbol! }, opts)
          : index.resolveCallees({ symbol: symbol! }, opts);

      const nextStep = nextStepFor(answer, kind);

      // The answer-shape fields are spread through unchanged. Only the
      // envelope is this tool's.
      return textResult({
        projectRoot: root,
        cacheHit,
        ...(args.site ? { resolvedSymbol: symbol } : {}),
        ...answer,
        ...(nextStep ? { nextStep } : {}),
      });
    };
}

export const makeFindCallersHandler = makeHandler('callers');
export const makeFindCalleesHandler = makeHandler('callees');
