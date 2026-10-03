#!/usr/bin/env node
/**
 * A `PostToolUse` hook: after a Read or Grep whose output names a Java method,
 * suggest `find_callers` for that method — **once per method name per
 * session**.
 *
 * Why it exists, measured. A paired bench (`engine-resolve` Phases 6–7) found
 * the navigation tools reached for in **1 of 12** runs where they were
 * available and the question was exactly theirs. Two levers were then tested
 * against each other on the same questions: changing the tool descriptions
 * moved selection **0 of 5** runs, and this hook moved it **6 of 6** (Fisher
 * exact two-tailed p = 0.0022). The reading of why, from the same data: the
 * tools are in the session's tool list but their schemas and descriptions are
 * fetched through a tool search, so a description cannot influence a choice
 * the agent never knows in detail — and every tool call in the trial was
 * preceded by such a search. Naming the tool is what prompts it.
 *
 * Why once per method name, and not once per session. A session that reads
 * twenty files asks about more than one symbol, and the suggestion is only
 * useful for the symbol in hand; but repeating it for a symbol already
 * suggested is noise, and noise is how a hook gets turned off. So the latch is
 * keyed by session **and** symbol.
 *
 * It only ever **suggests**. It calls no tool, runs no analysis, reads no file
 * beyond its own latch, blocks nothing and rewrites nothing. The decision
 * stays the agent's — which is also what made the bench a measurement of a
 * choice rather than of a redirect.
 *
 * Turning it off, two ways for two kinds of user. A plugin user sets the
 * `suggest_find_callers` option to false — it is a `userConfig` boolean, so it
 * appears as a row in `/config` and Claude Code exports it to this process as
 * `CLAUDE_PLUGIN_OPTION_SUGGEST_FIND_CALLERS`. Anyone wiring the hook up
 * directly, without the plugin, sets `COGNIUM_SUGGEST_FIND_CALLERS` instead.
 * Either accepts `off`, `0`, `false` or `no`. The hook then exits silently,
 * which is also what it does on any input it does not recognise.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The plugin option, and the bare env var for use outside the plugin. */
export const OPTION_ENV = 'CLAUDE_PLUGIN_OPTION_SUGGEST_FIND_CALLERS';
export const DISABLE_ENV = 'COGNIUM_SUGGEST_FIND_CALLERS';
const OFF = new Set(['off', '0', 'false', 'no']);

/**
 * A Java method declaration. Deliberately a declaration and not a call: a bare
 * `name(` matches far too much, and a declaration is the one shape that says
 * "this is a Java method" without a type resolver.
 *
 * The `(?:[\w<>[\],.]+\s+)+` is the **return type**, and requiring it is what
 * keeps a constructor out. `public AttackResult(` has a modifier and a name and
 * no return type, so an earlier version of this pattern captured the class name
 * and suggested finding the callers of `AttackResult` — measured end to end
 * against a real file, where the constructor is declared above the first
 * method. A constructor is not what this feature offers to answer about, and
 * `find_callers` takes a method symbol.
 */
const JAVA_METHOD = /\b(?:public|private|protected|static|final|abstract|synchronized)\s+(?:[\w<>[\],.]+\s+)+(\w+)\s*\([^)]*\)\s*(?:throws [\w., ]+)?[{;]/g;

/** Words that are never a method name, however the pattern lines up. */
const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'synchronized']);

export function isDisabled(env = process.env) {
  return [OPTION_ENV, DISABLE_ENV]
    .some((key) => OFF.has(String(env[key] ?? '').trim().toLowerCase()));
}

/** Every distinct Java method name in a tool's output, in the order they appear. */
export function methodNamesIn(text) {
  const names = [];
  const seen = new Set();
  for (const m of String(text).matchAll(JAVA_METHOD)) {
    if (!m[1] || seen.has(m[1]) || NOT_A_METHOD.has(m[1])) continue;
    seen.add(m[1]);
    names.push(m[1]);
  }
  return names;
}

export function suggestionFor(symbol) {
  return (
    `This repository has a Cognium MCP server with \`find_callers\` and \`find_callees\`. `
    + `For "who calls \`${symbol}\`?" call \`find_callers\` with \`symbol: "${symbol}"\`: it answers from a `
    + `call graph and labels how sure it is of each answer, where a text search finds the name rather `
    + `than the calls. Consider it before grepping further. (Suggested once per symbol; turn these `
    + `suggestions off with the cognium-dev option "suggest_find_callers".)`
  );
}

/** The latch path for one symbol in one session. Exported so a test can clear it. */
export function latchFor(session, symbol) {
  return join(tmpdir(), `cognium-sfc-${String(session).replace(/\W/g, '')}-${String(symbol).replace(/\W/g, '')}`);
}

function main() {
  if (isDisabled()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);                       // not our shape; say nothing
  }

  const tool = payload.tool_name ?? payload.toolName ?? '';
  if (!/^(Read|Grep)$/.test(tool)) process.exit(0);

  const out = JSON.stringify(payload.tool_response ?? payload.toolResponse ?? '');
  if (!/\.java/.test(out)) process.exit(0);

  const session = payload.session_id ?? payload.sessionId ?? 'unknown';

  // The first method in this output not already suggested in this session.
  // One suggestion per hook run: a Grep over a large tree names many methods,
  // and a hook that listed all of them would be the noise this exists to avoid.
  for (const symbol of methodNamesIn(out)) {
    const latch = latchFor(session, symbol);
    if (existsSync(latch)) continue;
    try {
      writeFileSync(latch, '1');
    } catch {
      /* a latch we cannot write is a hook that repeats; still better than failing */
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: suggestionFor(symbol),
      },
    }));
    return;
  }
}

// Only when run as the hook, so the helpers above can be imported by a test.
if (process.argv[1] && process.argv[1].endsWith('suggest-find-callers.mjs')) main();
