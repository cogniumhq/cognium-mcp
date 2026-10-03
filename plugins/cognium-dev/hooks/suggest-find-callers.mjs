#!/usr/bin/env node
/**
 * A `PostToolUse` hook: after a Read or Grep whose output mentions a Java
 * method, suggest `find_callers` — **once per session**.
 *
 * Why it exists. A paired bench found the navigation tools reached for on 1 of
 * 12 runs where they were available and the question was exactly theirs. The
 * tool descriptions are one lever on that; a nudge at the moment the agent is
 * already reading Java is the other, and this measures the second.
 *
 * Why it fires once. A hook that speaks after every Read is noise, and noise
 * is how a hook gets disabled. The once-per-session latch is in a temp file
 * keyed by the session id the hook is given.
 *
 * It only ever **suggests**. It blocks nothing, rewrites nothing, and has no
 * opinion about what the agent does next: the decision stays the agent's, so
 * what the bench measures is whether a suggestion changes a choice.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JAVA_METHOD = /\b(?:public|private|protected|static|final|abstract|synchronized)[\w<>\[\],\s]*\s+(\w+)\s*\([^)]*\)\s*(?:throws [\w., ]+)?[{;]/;

function main() {
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
  const m = JAVA_METHOD.exec(out);
  if (!m) process.exit(0);

  // Once per session.
  const session = String(payload.session_id ?? payload.sessionId ?? 'unknown').replace(/\W/g, '');
  const latch = join(tmpdir(), `cognium-suggest-find-callers-${session}`);
  if (existsSync(latch)) process.exit(0);
  try { writeFileSync(latch, '1'); } catch { /* a latch we cannot write is a hook that repeats; still better than failing */ }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `This repository has a Cognium MCP server with \`find_callers\` and \`find_callees\`. ` +
        `For "who calls \`${m[1]}\`?" that tool answers from a call graph and labels how sure it is ` +
        `of each answer, where a text search finds the name rather than the calls. Consider it ` +
        `before grepping further. (Suggested once per session.)`,
    },
  }));
}

main();
