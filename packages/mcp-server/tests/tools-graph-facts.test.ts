/**
 * `find_dead_code` and `removal_reach` (C4 0.3.0 §11, `language` from 0.4.0).
 *
 * What is pinned here:
 *   - the engine's `dead-code@0.1` / `removal-reach@0.1` answer is passed
 *     through, with the engine named and `provenance` last, the same as
 *     `structuredContent`, in one shape for every language;
 *   - the rule `no-inferred-edge-decides@0.1`: `unreachable` only with no
 *     path of any kind from a non-empty root set; `reachable` only on a
 *     strong path; an inferred entry, an inferred call, a reference, an
 *     unresolved site, an unparsed file (at the base, or the removal's own
 *     file at the head) or an empty root set leaves it `undecided`;
 *   - the evidence: the root set used (`entrySet`), the files read (`scope`)
 *     and the reasons per declaration (`decision.because`);
 *   - input validation: empty lists, overlapping trees, a language with no
 *     files, a tree too large to read whole;
 *   - through the server: the SDK validates the output schema, and both
 *     roots respect the allowed roots.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ReachPath } from 'circle-ir';
import { buildServer } from '../src/server.js';
import {
  makeFindDeadCodeHandler,
  makeRemovalReachHandler,
  engineIdentity,
  decide,
  weakReasons,
  entrySet,
  findDeadCodeInputShape,
  removalReachInputShape,
  DECISION_RULE,
} from '../src/tools/graph-facts.js';

const fixtures = resolve(__dirname, 'fixtures', 'graph-facts');
const base = resolve(fixtures, 'base');
const head = resolve(fixtures, 'head');
const rule = resolve(__dirname, 'fixtures', 'graph-facts-rule', 'project');
const partial = resolve(__dirname, 'fixtures', 'graph-facts-partial', 'project');

type Result = { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

function parse(r: Result) {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text) as Record<string, any>;
}

const endsWith = (items: any[], n: string) => items.find(f => String(f.qualified_name).endsWith(n));
const NO_PATH = ['no-strong-path', 'no-weak-path', 'no-unresolved-site', 'no-partial-file'];

describe('find_dead_code', () => {
  it('passes the engine\'s dead-code@0.1 answer through, with the engine named', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: base }));
    expect(out.scheme).toBe('dead-code@0.1');
    expect(out.ids).toBe('ids@0.1');
    expect(out.language).toBe('typescript');
    expect(out.engine).toEqual(engineIdentity());
    expect(out.engine.version).not.toBe('unknown');
    expect(typeof out.entryIndexDigest).toBe('string');
    expect(out.partial).toEqual([]);
    expect(out.partialFiles).toEqual([]);
    expect(endsWith(out.facts, 'greet')?.verdict).toBe('live');
    expect(endsWith(out.facts, 'format')?.verdict).toBe('live');
    expect(endsWith(out.facts, 'neverCalled')?.verdict).toBe('dead');
    expect(Object.keys(out).at(-1)).toBe('provenance');
    expect(out.provenance).toBe('deterministic');
  });

  it('decides every fact by the rule, in step with the engine\'s verdict, and says why', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: base }));
    const outcome = { live: 'reachable', 'may-be-live': 'undecided', dead: 'unreachable' } as const;
    for (const f of out.facts as any[]) expect(f.decision.outcome).toBe(outcome[f.verdict as keyof typeof outcome]);
    expect(out.decisions).toEqual({
      rule: DECISION_RULE,
      unreachable: out.summary.dead,
      reachable: out.summary.live,
      undecided: out.summary['may-be-live'],
    });
    expect(endsWith(out.facts, 'neverCalled').decision).toEqual({ outcome: 'unreachable', because: NO_PATH });
    expect(endsWith(out.facts, 'greet').decision).toEqual({ outcome: 'reachable', because: ['strong-path'] });
  });

  it('lists the roots the walk started from, and the files it read', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: base }));
    const set = out.entrySet;
    expect(set.rootKinds).toEqual(out.rootKinds);
    expect(set.total).toBeGreaterThan(0);
    expect(set.byKind).toEqual({ export: set.total });
    expect(set.byCertainty.declared + set.byCertainty.conventional + set.byCertainty.inferred).toBe(set.total);
    expect(set.entries).toHaveLength(set.total);
    expect(set.entries[0]).toMatchObject({ kind: 'export', file: 'src/index.ts' });
    expect(set.truncated).toBe(false);
    expect(typeof set.digest).toBe('string');
    expect(out.scope.searched).toEqual({ files: 2, languages: ['typescript', 'javascript'] });
    expect(out.scope.excluded).toContainEqual({ pattern: '**/node_modules/**', reason: 'not project source' });
    expect(out.note).toBeUndefined();
  });

  it('calls nothing unreachable when no entry of the root kinds exists', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: base, root_kinds: ['route'] }));
    expect(out.entrySet.total).toBe(0);
    expect(out.facts.length).toBeGreaterThan(0);
    // The engine's own verdicts are passed through untouched…
    expect(out.facts.every((f: any) => f.verdict === 'dead')).toBe(true);
    // …and the rule does not let an empty root set prove anything.
    for (const f of out.facts as any[]) expect(f.decision).toEqual({ outcome: 'undecided', because: ['no-entries'] });
    expect(out.decisions).toMatchObject({ unreachable: 0, reachable: 0, undecided: out.facts.length });
    expect(out.note).toMatch(/No entry of the root kinds/);
  });

  it('marks what only a weak path keeps alive as undecided, naming the weak step', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: resolve(rule, 'base') }));
    expect(endsWith(out.facts, 'onlyStored').decision).toEqual({ outcome: 'undecided', because: ['reference'] });
    expect(endsWith(out.facts, 'Box.paint').decision).toEqual({ outcome: 'undecided', because: ['inferred-call'] });
    expect(endsWith(out.facts, 'removedDead').decision).toEqual({ outcome: 'unreachable', because: NO_PATH });
  });

  it('marks what an unparsed file could reach as undecided', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: resolve(partial, 'base') }));
    expect(out.partial).toEqual(['src/legacy.ts']);
    expect(out.partialFiles[0].file).toBe('src/legacy.ts');
    expect(endsWith(out.facts, 'helperGone').decision).toEqual({ outcome: 'undecided', because: ['partial-file'] });
    expect(endsWith(out.facts, 'lib:gone').decision).toEqual({ outcome: 'unreachable', because: NO_PATH });
  });

  it('filters by verdict and says when it cut the list, while summary and decisions count everything', async () => {
    const all = parse(await makeFindDeadCodeHandler()({ project_root: base }));
    const dead = parse(await makeFindDeadCodeHandler()({ project_root: base, verdicts: ['dead'], limit: 1 }));
    expect(dead.facts.every((f: any) => f.verdict === 'dead')).toBe(true);
    expect(dead.facts.length).toBeLessThanOrEqual(1);
    expect(dead.truncated).toBe(dead.totalFacts > 1);
    expect(dead.summary).toEqual(all.summary);
    expect(dead.decisions).toEqual(all.decisions);
  });

  it('cuts the root list at limit too, saying so', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: resolve(rule, 'base'), limit: 1 }));
    expect(out.entrySet.total).toBe(3);
    expect(out.entrySet.entries).toHaveLength(1);
    expect(out.entrySet.truncated).toBe(true);
  });

  it('reads each root kind once', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: base, root_kinds: ['export', 'main', 'export'] }));
    expect(out.rootKinds).toEqual(['main', 'export']);
    expect(out.entrySet.rootKinds).toEqual(['main', 'export']);
  });

  it('returns a structured copy of the answer', async () => {
    const r = await makeFindDeadCodeHandler()({ project_root: base });
    expect(r.structuredContent).toEqual(JSON.parse(r.content[0].text));
  });

  it('answers a missing root with one line and isError', async () => {
    const r = await makeFindDeadCodeHandler()({ project_root: resolve(fixtures, 'nope') });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Error: project_root does not exist/);
    const f = await makeFindDeadCodeHandler()({ project_root: resolve(base, 'package.json') });
    expect(f.content[0].text).toMatch(/^Error: project_root is not a directory/);
  });

  it('refuses empty lists, in the schema and in the handler', async () => {
    expect(findDeadCodeInputShape.root_kinds.safeParse([]).success).toBe(false);
    expect(findDeadCodeInputShape.verdicts.safeParse([]).success).toBe(false);
    expect(removalReachInputShape.root_kinds.safeParse([]).success).toBe(false);
    const k = await makeFindDeadCodeHandler()({ project_root: base, root_kinds: [] });
    expect(k.isError).toBe(true);
    expect(k.content[0].text).toMatch(/root_kinds is empty/);
    const v = await makeFindDeadCodeHandler()({ project_root: base, verdicts: [] });
    expect(v.content[0].text).toMatch(/verdicts is empty/);
  });

  it('refuses a language with no files under the root, rather than answer over nothing', async () => {
    const r = await makeFindDeadCodeHandler()({ project_root: base, language: 'python' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Error: no Python files under project_root/);
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'cognium-gf-empty-')));
    try {
      writeFileSync(join(empty, 'README.md'), 'no source here\n');
      const none = await makeFindDeadCodeHandler()({ project_root: empty });
      expect(none.content[0].text).toMatch(/^Error: no Java, TypeScript, JavaScript, Python or Go files under project_root/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses a tree too large to read whole', async () => {
    const r = await makeFindDeadCodeHandler({ maxFiles: 2 })({ project_root: base });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/2 or more TypeScript\/JavaScript files/);
  });
});

describe('removal_reach', () => {
  it('lists what disappeared between the two pins, with what reached it at the base', async () => {
    const out = parse(await makeRemovalReachHandler()({ project_root: head, baseline_root: base }));
    expect(out.scheme).toBe('removal-reach@0.1');
    expect(out.projectRoot).toBe(head);
    expect(out.baselineRoot).toBe(base);
    expect(out.language).toBe('typescript');
    const names = (out.removed as any[]).map(r => r.qualified_name);
    expect(names.some(n => n.endsWith('neverCalled'))).toBe(true);
    expect(names.some(n => n.endsWith('format'))).toBe(false);
    const never = endsWith(out.removed, 'neverCalled');
    expect(never.strong).toBeNull();
    expect(never.decision).toEqual({ outcome: 'unreachable', because: NO_PATH });
    expect(out.decisions).toEqual({ rule: DECISION_RULE, unreachable: 1, reachable: 0, undecided: 0, allUnreachable: true });
    expect(out.totalRemoved).toBe(out.removed.length);
    expect(out.truncated).toBe(false);
    expect(out.scope.searched).toEqual({ files: 2, headFiles: 2, languages: ['typescript', 'javascript'] });
    expect(Object.keys(out).at(-1)).toBe('provenance');
    expect(out.provenance).toBe('deterministic');
  });

  it('applies no-inferred-edge-decides to each removal, read both ways', async () => {
    const out = parse(await makeRemovalReachHandler()({ project_root: resolve(rule, 'head'), baseline_root: resolve(rule, 'base') }));
    expect(endsWith(out.removed, 'removedLive').decision).toEqual({ outcome: 'reachable', because: ['strong-path'] });
    expect(endsWith(out.removed, 'onlyStored').decision).toEqual({ outcome: 'undecided', because: ['reference'] });
    expect(endsWith(out.removed, 'Box.paint').decision).toEqual({ outcome: 'undecided', because: ['inferred-call'] });
    expect(endsWith(out.removed, 'removedDead').decision).toEqual({ outcome: 'unreachable', because: NO_PATH });
    expect(out.decisions).toEqual({ rule: DECISION_RULE, unreachable: 1, reachable: 1, undecided: 2, allUnreachable: false });
    // The base roots the decisions were read against.
    expect(out.entrySet.total).toBe(3);
    expect(out.entrySet.entries.map((e: any) => `${e.kind} ${e.file}:${e.line}`)).toEqual([
      'export src/index.ts:4',
      'export src/index.ts:8',
      'export src/index.ts:13',
    ]);
  });

  it('leaves a removal undecided when an unparsed file could reach it, or its own file did not parse at the head', async () => {
    const out = parse(await makeRemovalReachHandler()({ project_root: resolve(partial, 'head'), baseline_root: resolve(partial, 'base') }));
    expect(out.partial).toEqual(['src/legacy.ts', 'src/lib.ts']);
    expect(out.partialFiles.map((p: any) => p.file)).toEqual(out.partial);
    expect(endsWith(out.removed, 'helperGone').decision).toEqual({ outcome: 'undecided', because: ['partial-file'] });
    expect(endsWith(out.removed, 'lib:gone').decision).toEqual({ outcome: 'undecided', because: ['partial-at-head'] });
    expect(out.decisions.allUnreachable).toBeNull();
  });

  it('says allUnreachable is null when nothing was removed', async () => {
    // Reversed: the head adds `neverCalled`, nothing disappears.
    const out = parse(await makeRemovalReachHandler()({ project_root: base, baseline_root: head }));
    expect(out.removed).toEqual([]);
    expect(out.decisions).toEqual({ rule: DECISION_RULE, unreachable: 0, reachable: 0, undecided: 0, allUnreachable: null });
  });

  it('with no roots of the kinds asked, decides nothing', async () => {
    const out = parse(await makeRemovalReachHandler()({ project_root: head, baseline_root: base, root_kinds: ['route'] }));
    expect(endsWith(out.removed, 'neverCalled').decision).toEqual({ outcome: 'undecided', because: ['no-entries'] });
    expect(out.decisions.allUnreachable).toBeNull();
    expect(out.note).toMatch(/No entry of the root kinds/);
  });

  it('cuts the removed list at limit, counting everything', async () => {
    const out = parse(await makeRemovalReachHandler()({ project_root: resolve(rule, 'head'), baseline_root: resolve(rule, 'base'), limit: 1 }));
    expect(out.removed).toHaveLength(1);
    expect(out.totalRemoved).toBe(4);
    expect(out.truncated).toBe(true);
    expect(out.decisions).toMatchObject({ unreachable: 1, reachable: 1, undecided: 2 });
  });

  it('refuses a missing baseline with one line', async () => {
    const r = await makeRemovalReachHandler()({ project_root: head, baseline_root: resolve(fixtures, 'nope') });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Error: baseline_root does not exist/);
  });

  it('refuses the same tree twice, and trees that hold one another', async () => {
    const same = await makeRemovalReachHandler()({ project_root: base, baseline_root: base });
    expect(same.isError).toBe(true);
    expect(same.content[0].text).toMatch(/same directory/);
    const nested = await makeRemovalReachHandler()({ project_root: fixtures, baseline_root: base });
    expect(nested.content[0].text).toMatch(/overlap/);
    const nested2 = await makeRemovalReachHandler()({ project_root: base, baseline_root: fixtures });
    expect(nested2.content[0].text).toMatch(/overlap/);
  });

  it('refuses an empty root_kinds, a head without the family, and a mixed pair', async () => {
    const k = await makeRemovalReachHandler()({ project_root: head, baseline_root: base, root_kinds: [] });
    expect(k.content[0].text).toMatch(/root_kinds is empty/);
    const py = resolve(__dirname, 'fixtures', 'graph-facts-python', 'head');
    const mixed = await makeRemovalReachHandler()({ project_root: py, baseline_root: base });
    expect(mixed.content[0].text).toMatch(/pass `language`/);
    const noHead = await makeRemovalReachHandler()({ project_root: py, baseline_root: base, language: 'typescript' });
    expect(noHead.content[0].text).toMatch(/^Error: no TypeScript\/JavaScript files under project_root/);
  });

  it('refuses a tree too large to read whole', async () => {
    const r = await makeRemovalReachHandler({ maxFiles: 2 })({ project_root: head, baseline_root: base });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/or more TypeScript\/JavaScript files/);
  });
});

describe('the rule, fact by fact', () => {
  const entry = (certainty: 'declared' | 'conventional' | 'inferred') => ({ id: 'e', kind: 'export' as const, certainty });
  const path = (cls: 'strong' | 'weak', certainty: 'declared' | 'inferred', steps: ReachPath['steps']): ReachPath => ({
    class: cls,
    entry: entry(certainty),
    steps,
  });
  const strong = path('strong', 'declared', [{ decl: 'e', via: 'entry' }, { decl: 'x', via: 'call', tier: 'exact' }]);
  const none = { strong: null, weak: null, unresolvedCount: 0 };

  it('names each weak step, in a fixed order, and falls back when it knows none', () => {
    const w = path('weak', 'inferred', [
      { decl: 'e', via: 'entry' },
      { decl: 'a', via: 'reference' },
      { decl: 'b', via: 'call', tier: 'inferred' },
      { decl: 'c', via: 'call', tier: 'exact' },
    ]);
    expect(weakReasons(w)).toEqual(['inferred-entry', 'inferred-call', 'reference']);
    expect(weakReasons(path('weak', 'declared', [{ decl: 'e', via: 'entry' }, { decl: 'a', via: 'loads' }]))).toEqual(['weak-path']);
  });

  it('a strong path decides, unless the removal itself is in doubt', () => {
    expect(decide({ ...none, strong }, { roots: 1, partialReach: false })).toEqual({ outcome: 'reachable', because: ['strong-path'] });
    expect(decide({ ...none, strong }, { roots: 1, partialReach: false, partialAtHead: true })).toEqual({
      outcome: 'undecided',
      because: ['partial-at-head', 'strong-path'],
    });
  });

  it('nothing at all is unreachable, but only against a root set', () => {
    expect(decide(none, { roots: 2, partialReach: false })).toEqual({ outcome: 'unreachable', because: NO_PATH });
    expect(decide(none, { roots: 0, partialReach: false })).toEqual({ outcome: 'undecided', because: ['no-entries'] });
  });

  it('every reason that applies is listed', () => {
    const weak = path('weak', 'declared', [{ decl: 'e', via: 'entry' }, { decl: 'x', via: 'call', tier: 'inferred' }]);
    expect(decide({ strong: null, weak, unresolvedCount: 3 }, { roots: 1, partialReach: true, partialAtHead: true })).toEqual({
      outcome: 'undecided',
      because: ['partial-at-head', 'inferred-call', 'unresolved-site', 'partial-file'],
    });
    expect(decide({ ...none, unresolvedCount: 1 }, { roots: 1, partialReach: false })).toEqual({
      outcome: 'undecided',
      because: ['unresolved-site'],
    });
  });

  it('entrySet keeps only the root kinds, in place order, with optional fields only when present', () => {
    const set = entrySet(
      [
        { id: 'b', kind: 'route', certainty: 'declared', method: 'GET', path: '/x', file: 'b.ts', line: 3 },
        { id: 'a', kind: 'test', certainty: 'conventional', file: 'a.test.ts', line: 1 },
        { id: 'c', kind: 'main', certainty: 'inferred', file: 'a.ts', line: 9 },
      ],
      ['main', 'route'],
      10,
    );
    expect(set.entries).toEqual([
      { id: 'c', kind: 'main', certainty: 'inferred', file: 'a.ts', line: 9 },
      { id: 'b', kind: 'route', certainty: 'declared', method: 'GET', path: '/x', file: 'b.ts', line: 3 },
    ]);
    expect(set.byKind).toEqual({ route: 1, main: 1 });
    expect(set.byCertainty).toEqual({ declared: 1, conventional: 0, inferred: 1 });
    // An entry naming no declaration starts no walk, so it is no evidence.
    const files = [{ file: 'a.ts', decls: [{ id: 'c' }] }] as unknown as Parameters<typeof entrySet>[3];
    const known = entrySet([{ id: 'b', kind: 'route', certainty: 'declared', file: 'b.ts', line: 3 },
      { id: 'c', kind: 'main', certainty: 'inferred', file: 'a.ts', line: 9 }], ['main', 'route'], 10, files);
    expect(known.entries.map(e => e.id)).toEqual(['c']);
    expect(known.total).toBe(1);
  });
});

describe('Java projects (buildJavaGraph)', () => {
  const jbase = resolve(__dirname, 'fixtures', 'graph-facts-java', 'base');
  const jhead = resolve(__dirname, 'fixtures', 'graph-facts-java', 'head');

  it('find_dead_code answers a Java tree in the same shape', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: jbase }));
    expect(out.scheme).toBe('dead-code@0.1');
    expect(out.ids).toBe('ids@0.1');
    expect(out.language).toBe('java');
    const ts = parse(await makeFindDeadCodeHandler()({ project_root: base }));
    expect(Object.keys(out)).toEqual(Object.keys(ts));
    const find = (n: string) => (out.facts as any[]).find(f => f.qualified_name.includes(n));
    expect(find('main')?.verdict).toBe('live');
    expect(find('format')?.verdict).toBe('live');
    expect(find('neverCalled')?.verdict).toBe('dead');
    expect(find('neverCalled')?.decision.outcome).toBe('unreachable');
    expect(out.entrySet.byKind.main).toBeGreaterThan(0);
  });

  it('removal_reach answers a Java pin pair in the same shape', async () => {
    const out = parse(await makeRemovalReachHandler()({ project_root: jhead, baseline_root: jbase }));
    expect(out.scheme).toBe('removal-reach@0.1');
    const names = (out.removed as any[]).map(r => r.qualified_name);
    expect(names.some(n => n.includes('neverCalled'))).toBe(true);
    expect(names.some(n => n.includes('format'))).toBe(false);
    expect(out.decisions.allUnreachable).toBe(true);
    const ts = parse(await makeRemovalReachHandler()({ project_root: head, baseline_root: base }));
    expect(Object.keys(out)).toEqual(Object.keys(ts));
  });

  it('asks for `language` when a tree holds both Java and TypeScript, and honours it', async () => {
    const mixed = resolve(__dirname, 'fixtures', 'mixed');
    const r = await makeFindDeadCodeHandler()({ project_root: mixed });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/pass `language`/);
    const j = parse(await makeFindDeadCodeHandler()({ project_root: mixed, language: 'java' }));
    expect((j.facts as any[]).every(f => f.file.endsWith('.java'))).toBe(true);
    const t = parse(await makeFindDeadCodeHandler()({ project_root: mixed, language: 'javascript' }));
    expect(t.language).toBe('typescript');
    expect((t.facts as any[]).every(f => !f.file.endsWith('.java'))).toBe(true);
  });

  describe('META-INF/services', () => {
    let tmp: string;
    beforeAll(() => {
      tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cognium-gf-')));
      const write = (p: string, text: string) => {
        mkdirSync(dirname(join(tmp, p)), { recursive: true });
        writeFileSync(join(tmp, p), text);
      };
      write('project/src/main/java/app/Main.java', 'package app;\npublic class Main { public static void main(String[] a) {} }\n');
      write('project/src/main/java/app/Plugin.java', 'package app;\npublic class Plugin { public void run() {} }\n');
      write('project/src/main/java/app/Other.java', 'package app;\npublic class Other { public void run() {} }\n');
      write('project/src/main/resources/META-INF/services/app.Spi', 'app.Plugin\n');
      // A services directory reached through a symlink is outside the tree: not read.
      write('outside/META-INF/services/app.Spi', 'app.Other\n');
      mkdirSync(join(tmp, 'project', 'lib'), { recursive: true });
      symlinkSync(join(tmp, 'outside'), join(tmp, 'project', 'lib', 'escape'));
    });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    it('feed reflection entries, and a symlink is never followed out of the tree', async () => {
      const out = parse(await makeFindDeadCodeHandler()({ project_root: join(tmp, 'project') }));
      const reflection = (out.entrySet.entries as any[]).filter(e => e.kind === 'reflection');
      expect(reflection.length).toBeGreaterThan(0);
      expect(reflection.every(e => !String(e.file).includes('escape'))).toBe(true);
      expect(endsWith(out.facts, 'Plugin')?.decision.outcome).toBe('reachable');
      expect(endsWith(out.facts, 'Other')?.decision.outcome).not.toBe('reachable');
    });
  });
});

describe.each([
  { language: 'python' as const, dir: 'graph-facts-python', entry: 'main', live: 'fmt', dead: 'never_called' },
  { language: 'go' as const, dir: 'graph-facts-go', entry: 'main', live: 'Format', dead: 'neverCalled' },
])('$language projects', ({ language, dir, entry, live, dead }) => {
  const lbase = resolve(__dirname, 'fixtures', dir, 'base');
  const lhead = resolve(__dirname, 'fixtures', dir, 'head');
  const named = (facts: any[], n: string) => facts.find(f => String(f.qualified_name).split(/[.:#/ ]/).includes(n));

  it('find_dead_code answers in the same shape, detecting the language', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: lbase }));
    const ts = parse(await makeFindDeadCodeHandler()({ project_root: base }));
    expect(Object.keys(out)).toEqual(Object.keys(ts));
    expect(out.scheme).toBe('dead-code@0.1');
    expect(out.language).toBe(language);
    expect(named(out.facts, entry)?.verdict).toBe('live');
    expect(named(out.facts, live)?.verdict).toBe('live');
    expect(named(out.facts, dead)?.verdict).toBe('dead');
    expect(named(out.facts, dead)?.decision).toEqual({ outcome: 'unreachable', because: NO_PATH });
    const asked = parse(await makeFindDeadCodeHandler()({ project_root: lbase, language }));
    expect(asked.facts).toEqual(out.facts);
  });

  it('removal_reach answers a pin pair in the same shape', async () => {
    const out = parse(await makeRemovalReachHandler()({ project_root: lhead, baseline_root: lbase }));
    const ts = parse(await makeRemovalReachHandler()({ project_root: head, baseline_root: base }));
    expect(Object.keys(out)).toEqual(Object.keys(ts));
    expect(out.scheme).toBe('removal-reach@0.1');
    expect(named(out.removed, dead)?.decision.outcome).toBe('unreachable');
    expect(named(out.removed, live)).toBeUndefined();
  });
});

describe('project metadata the entry index reads', () => {
  let tmp: string;
  const write = (p: string, text: string) => {
    mkdirSync(dirname(join(tmp, p)), { recursive: true });
    writeFileSync(join(tmp, p), text);
  };
  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cognium-gf-meta-')));
    write('py/pkg/__init__.py', '');
    write('py/pkg/cli.py', 'def run():\n    return helper()\n\n\ndef helper():\n    return 1\n');
    write('py-scripts/pkg/__init__.py', '');
    write('py-scripts/pkg/cli.py', 'def run():\n    return helper()\n\n\ndef helper():\n    return 1\n');
    write(
      'py-scripts/pyproject.toml',
      '[project]\nname = "pkg"\n\n[project.scripts]\ntool = "pkg.cli:run"\n# a comment\n\n[tool.other]\nx = "pkg.cli:helper"\n',
    );
    write('go-nomod/main.go', 'package main\n\nfunc main() { greet() }\n\nfunc greet() {}\n\nfunc unused() {}\n');
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('Python console scripts in pyproject.toml are entries', async () => {
    const without = parse(await makeFindDeadCodeHandler()({ project_root: join(tmp, 'py') }));
    const withScripts = parse(await makeFindDeadCodeHandler()({ project_root: join(tmp, 'py-scripts') }));
    const run = (out: any) => (out.facts as any[]).find(f => String(f.qualified_name).endsWith('run'));
    expect(run(without)?.decision.outcome).not.toBe('reachable');
    expect(run(withScripts)?.decision).toEqual({ outcome: 'reachable', because: ['strong-path'] });
    expect(withScripts.entrySet.byKind.main).toBe(1);
  });

  it('a Go tree without go.mod is still read', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: join(tmp, 'go-nomod') }));
    expect(out.language).toBe('go');
    expect((out.facts as any[]).find(f => String(f.qualified_name).endsWith('unused'))?.decision.outcome).toBe('unreachable');
  });
});

describe('through the server', () => {
  let tmp: string;
  let client: Client;
  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cognium-gf-roots-')));
    mkdirSync(join(tmp, 'outside', 'src'), { recursive: true });
    mkdirSync(join(tmp, 'inside'));
    writeFileSync(join(tmp, 'outside', 'src', 'a.ts'), 'export function a(): void {}\n');
    symlinkSync(join(tmp, 'outside'), join(tmp, 'inside', 'escape-link'));
    const server = buildServer({ allowedRoots: [resolve(__dirname, 'fixtures'), join(tmp, 'inside')] });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    client = new Client({ name: 'graph-facts', version: '0' });
    await client.connect(c);
    await client.listTools();
  });
  afterAll(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('serves both tools with output the SDK validates against their schemas', async () => {
    const d = (await client.callTool({ name: 'find_dead_code', arguments: { project_root: resolve(rule, 'base') } })) as Result;
    expect(d.isError).toBeFalsy();
    expect(d.structuredContent).toEqual(JSON.parse(d.content[0].text));
    const r = (await client.callTool({
      name: 'removal_reach',
      arguments: { project_root: resolve(rule, 'head'), baseline_root: resolve(rule, 'base') },
    })) as Result;
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as any).decisions.allUnreachable).toBe(false);
  });

  it('refuses an empty root_kinds before the tool runs', async () => {
    // The SDK answers a schema violation either as an error result or as a protocol error.
    const refused = await client.callTool({ name: 'find_dead_code', arguments: { project_root: base, root_kinds: [] } }).then(
      r => (r as Result).isError === true,
      () => true,
    );
    expect(refused).toBe(true);
  });

  it.each([
    ['find_dead_code', { project_root: 'OUT' }],
    ['removal_reach', { project_root: 'OUT', baseline_root: 'BASE' }],
    ['removal_reach', { project_root: 'HEAD', baseline_root: 'OUT' }],
    ['removal_reach', { project_root: 'HEAD', baseline_root: 'LINK' }],
  ])('%s refuses a root outside the allowed roots: %j', async (name, args) => {
    const value = (v: string) =>
      v === 'OUT' ? join(tmp, 'outside') : v === 'LINK' ? join(tmp, 'inside', 'escape-link') : v === 'BASE' ? base : head;
    const r = (await client.callTool({
      name,
      arguments: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, value(v)])),
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outside the allowed roots/);
  });
});
