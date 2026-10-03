/**
 * The suggestion hook's contract, asserted against the hook as Claude Code
 * runs it: a child process, a JSON payload on stdin, JSON or nothing on stdout.
 *
 * The behaviours tested are the ones the feature promises, so each is here
 * because breaking it would change what a user experiences: it suggests for a
 * Java method, it names the symbol, it never repeats a symbol inside a session,
 * it *does* speak again for a different symbol, a setting turns it off, and it
 * stays silent on everything it does not understand. The last group matters
 * most: a PostToolUse hook that errors or chatters on unexpected input is a
 * hook the user disables, and then the measured effect is zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DISABLE_ENV, OPTION_ENV, methodNamesIn, suggestionFor, latchFor, isDisabled,
} from './suggest-find-callers.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'suggest-find-callers.mjs');

const JAVA = 'Lesson.java:91:  public AttackResult assignmentSolved(String feedback) {';
const JAVA_TWO = 'Other.java:12:  private void loadAndCache(String key) {';

/** Run the hook the way the harness does, with a session nothing else shares. */
function run(payload, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, [DISABLE_ENV]: '', [OPTION_ENV]: '', ...env },
  });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function session() {
  return `t${process.pid}x${Math.random().toString(36).slice(2)}`;
}

function clear(s, ...symbols) {
  for (const sym of symbols) rmSync(latchFor(s, sym), { force: true });
}

test('suggests find_callers for a Java method, naming the symbol', () => {
  const s = session();
  clear(s, 'assignmentSolved');
  const { status, stdout } = run({ tool_name: 'Grep', session_id: s, tool_response: JAVA });
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  const ctx = out.hookSpecificOutput.additionalContext;
  // The symbol must be filled in, not left as a generic nudge: the whole point
  // is that the agent can act on it without first working out what to ask.
  assert.match(ctx, /assignmentSolved/);
  assert.match(ctx, /find_callers/);
  assert.match(ctx, /symbol: "assignmentSolved"/);
  clear(s, 'assignmentSolved');
});

test('never fires twice for the same symbol in a session', () => {
  const s = session();
  clear(s, 'assignmentSolved');
  const first = run({ tool_name: 'Grep', session_id: s, tool_response: JAVA });
  const second = run({ tool_name: 'Grep', session_id: s, tool_response: JAVA });
  assert.notEqual(first.stdout, '');
  assert.equal(second.stdout, '', 'the second run for the same symbol must say nothing');
  assert.equal(second.status, 0);
  clear(s, 'assignmentSolved');
});

test('still fires for a different symbol in the same session', () => {
  const s = session();
  clear(s, 'assignmentSolved', 'loadAndCache');
  const first = run({ tool_name: 'Grep', session_id: s, tool_response: JAVA });
  const second = run({ tool_name: 'Read', session_id: s, tool_response: JAVA_TWO });
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /assignmentSolved/);
  assert.match(JSON.parse(second.stdout).hookSpecificOutput.additionalContext, /loadAndCache/);
  clear(s, 'assignmentSolved', 'loadAndCache');
});

test('the same symbol in a different session is suggested again', () => {
  const a = session();
  const b = session();
  clear(a, 'assignmentSolved');
  clear(b, 'assignmentSolved');
  assert.notEqual(run({ tool_name: 'Grep', session_id: a, tool_response: JAVA }).stdout, '');
  assert.notEqual(run({ tool_name: 'Grep', session_id: b, tool_response: JAVA }).stdout, '');
  clear(a, 'assignmentSolved');
  clear(b, 'assignmentSolved');
});

test('one suggestion per run even when the output names many methods', () => {
  const s = session();
  clear(s, 'assignmentSolved', 'loadAndCache');
  const { stdout } = run({ tool_name: 'Grep', session_id: s, tool_response: `${JAVA}\n${JAVA_TWO}` });
  // Exactly one JSON object, not one per method: a Grep over a tree names many.
  assert.doesNotThrow(() => JSON.parse(stdout));
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /assignmentSolved/);
  assert.doesNotMatch(ctx, /loadAndCache/);
  clear(s, 'assignmentSolved', 'loadAndCache');
});

for (const value of ['off', '0', 'false', 'no', 'OFF', ' off ']) {
  test(`the setting turns it off: ${DISABLE_ENV}=${JSON.stringify(value)}`, () => {
    const s = session();
    clear(s, 'assignmentSolved');
    const { status, stdout } = run(
      { tool_name: 'Grep', session_id: s, tool_response: JAVA },
      { env: { [DISABLE_ENV]: value } },
    );
    assert.equal(stdout, '');
    assert.equal(status, 0);
    clear(s, 'assignmentSolved');
  });
}

test('the plugin option turns it off, which is what a /config row sets', () => {
  // Claude Code exports the userConfig boolean as CLAUDE_PLUGIN_OPTION_<KEY>,
  // so this is the path a plugin user actually takes when they untick it.
  const s = session();
  clear(s, 'assignmentSolved');
  const { status, stdout } = run(
    { tool_name: 'Grep', session_id: s, tool_response: JAVA },
    { env: { [OPTION_ENV]: 'false' } },
  );
  assert.equal(stdout, '');
  assert.equal(status, 0);
  clear(s, 'assignmentSolved');
});

test('isDisabled reads either setting, and neither being set leaves it on', () => {
  assert.equal(isDisabled({}), false);
  assert.equal(isDisabled({ [OPTION_ENV]: 'true' }), false);
  assert.equal(isDisabled({ [OPTION_ENV]: 'false' }), true);
  assert.equal(isDisabled({ [DISABLE_ENV]: 'off' }), true);
  // The plugin default is true, so an enabled plugin passes "true" through.
  assert.equal(isDisabled({ [OPTION_ENV]: 'true', [DISABLE_ENV]: '' }), false);
});

test('an unset or unrelated setting value leaves it on', () => {
  const s = session();
  clear(s, 'assignmentSolved');
  const { stdout } = run({ tool_name: 'Grep', session_id: s, tool_response: JAVA }, { env: { [DISABLE_ENV]: 'on' } });
  assert.notEqual(stdout, '');
  clear(s, 'assignmentSolved');
});

// Everything it must stay quiet about. Each case is a separate session so a
// latch can never be the reason for the silence.
const silent = [
  ['a tool that is not Read or Grep', { tool_name: 'Bash', tool_response: JAVA }],
  ['output with no .java path', { tool_name: 'Grep', tool_response: 'README.md:1: def foo(): pass' }],
  ['a .java path with no method declaration', { tool_name: 'Read', tool_response: 'Lesson.java:1: package org.owasp;' }],
  ['an empty response', { tool_name: 'Grep', tool_response: '' }],
  ['a missing tool_response', { tool_name: 'Grep' }],
  ['a missing tool name', { tool_response: JAVA }],
];

for (const [name, partial] of silent) {
  test(`silent on ${name}`, () => {
    const { status, stdout, stderr } = run({ ...partial, session_id: session() });
    assert.equal(stdout, '', `expected silence, got ${stdout}`);
    assert.equal(status, 0, `expected a clean exit, got ${status}: ${stderr}`);
  });
}

test('silent and clean on a malformed payload', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal((r.stdout ?? '').trim(), '');
  assert.equal(r.status, 0);
});

test('silent and clean on empty stdin', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: '', encoding: 'utf8' });
  assert.equal((r.stdout ?? '').trim(), '');
  assert.equal(r.status, 0);
});

test('methodNamesIn returns distinct names in order, and nothing for prose', () => {
  assert.deepEqual(methodNamesIn(`${JAVA}\n${JAVA_TWO}\n${JAVA}`), ['assignmentSolved', 'loadAndCache']);
  assert.deepEqual(methodNamesIn('just some prose about assignmentSolved()'), []);
});

test('a constructor is not a method, so it is never suggested', () => {
  // Measured end to end first: the real AttackResult.java declares its
  // constructor above its first method, and an earlier pattern captured the
  // class name and offered to find the callers of `AttackResult`.
  assert.deepEqual(methodNamesIn('AttackResult.java:36:  public AttackResult('), []);
  assert.deepEqual(
    methodNamesIn('AttackResult.java:36:  public AttackResult(\nAttackResult.java:53:  public boolean assignmentSolved() {'),
    ['assignmentSolved'],
    'the constructor is skipped and the method below it is the one suggested',
  );
});

test('method shapes that must still be recognised', () => {
  assert.deepEqual(methodNamesIn('A.java:1: public static void main(String[] args) {'), ['main']);
  assert.deepEqual(methodNamesIn('A.java:1: public List<String> getNames() {'), ['getNames']);
  assert.deepEqual(methodNamesIn('A.java:1: protected final Map<String, Integer> tally(int n) {'), ['tally']);
  assert.deepEqual(methodNamesIn('A.java:1: public void save(Thing t) throws IOException {'), ['save']);
  assert.deepEqual(methodNamesIn('A.java:1: abstract String getTitle();'), ['getTitle']);
});

test('a control-flow keyword is never offered as a method', () => {
  assert.deepEqual(methodNamesIn('A.java:1: public void f() { if (x) { return; } }').includes('if'), false);
});

test('the suggestion never tells the agent a tool was already run', () => {
  // It suggests; it must not imply an action was taken on the agent's behalf,
  // or the agent may report results it never fetched.
  const ctx = suggestionFor('getTitle');
  assert.doesNotMatch(ctx, /\b(I |already |has been |ran|called it|results below)\b/i);
  assert.match(ctx, /Consider it/);
});
