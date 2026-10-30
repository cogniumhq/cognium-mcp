import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { makeFindDeadCodeHandler, makeRemovalReachHandler, engineIdentity } from '../src/tools/graph-facts.js';

const fixtures = resolve(__dirname, 'fixtures', 'graph-facts');
const base = resolve(fixtures, 'base');
const head = resolve(fixtures, 'head');

function parse(r: { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }) {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text) as Record<string, any>;
}

describe('find_dead_code', () => {
  it('passes the engine\'s dead-code@0.1 answer through, with the engine named', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: base }));
    expect(out.scheme).toBe('dead-code@0.1');
    expect(out.ids).toBe('ids@0.1');
    expect(out.engine).toEqual(engineIdentity());
    expect(out.engine.version).not.toBe('unknown');
    expect(typeof out.entryIndexDigest).toBe('string');
    const byName = new Map((out.facts as any[]).map(f => [f.qualified_name, f]));
    const greet = [...byName.entries()].find(([n]) => n.endsWith('greet'))?.[1];
    const format = [...byName.entries()].find(([n]) => n.endsWith('format'))?.[1];
    const never = [...byName.entries()].find(([n]) => n.endsWith('neverCalled'))?.[1];
    expect(greet?.verdict).toBe('live');
    expect(format?.verdict).toBe('live');
    expect(never?.verdict).toBe('dead');
    expect(Object.keys(out).at(-1)).toBe('provenance');
    expect(out.provenance).toBe('deterministic');
  });

  it('filters by verdict and says when it cut the list, while summary counts everything', async () => {
    const all = parse(await makeFindDeadCodeHandler()({ project_root: base }));
    const dead = parse(await makeFindDeadCodeHandler()({ project_root: base, verdicts: ['dead'], limit: 1 }));
    expect(dead.facts.every((f: any) => f.verdict === 'dead')).toBe(true);
    expect(dead.facts.length).toBeLessThanOrEqual(1);
    expect(dead.truncated).toBe(dead.totalFacts > 1);
    expect(dead.summary).toEqual(all.summary);
  });

  it('returns a structured copy of the answer', async () => {
    const r = await makeFindDeadCodeHandler()({ project_root: base });
    expect(r.structuredContent).toEqual(JSON.parse(r.content[0].text));
  });

  it('answers a missing root with one line and isError', async () => {
    const r = await makeFindDeadCodeHandler()({ project_root: resolve(fixtures, 'nope') });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Error: project_root does not exist/);
  });
});

describe('removal_reach', () => {
  it('lists what disappeared between the two pins, with what reached it at the base', async () => {
    const out = parse(await makeRemovalReachHandler()({ project_root: head, baseline_root: base }));
    expect(out.scheme).toBe('removal-reach@0.1');
    expect(out.projectRoot).toBe(head);
    expect(out.baselineRoot).toBe(base);
    const names = (out.removed as any[]).map(r => r.qualified_name);
    expect(names.some(n => n.endsWith('neverCalled'))).toBe(true);
    expect(names.some(n => n.endsWith('format'))).toBe(false);
    const never = (out.removed as any[]).find(r => r.qualified_name.endsWith('neverCalled'));
    expect(never.strong).toBeNull();
    expect(out.totalRemoved).toBe(out.removed.length);
    expect(out.truncated).toBe(false);
    expect(out.provenance).toBe('deterministic');
  });

  it('refuses a missing baseline with one line', async () => {
    const r = await makeRemovalReachHandler()({ project_root: head, baseline_root: resolve(fixtures, 'nope') });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Error: baseline_root does not exist/);
  });
});

describe('Java projects (buildJavaGraph)', () => {
  const jbase = resolve(__dirname, 'fixtures', 'graph-facts-java', 'base');
  const jhead = resolve(__dirname, 'fixtures', 'graph-facts-java', 'head');

  it('find_dead_code answers a Java tree in the same shape', async () => {
    const out = parse(await makeFindDeadCodeHandler()({ project_root: jbase }));
    expect(out.scheme).toBe('dead-code@0.1');
    expect(out.ids).toBe('ids@0.1');
    const ts = parse(await makeFindDeadCodeHandler()({ project_root: base }));
    expect(Object.keys(out)).toEqual(Object.keys(ts));
    const find = (n: string) => (out.facts as any[]).find(f => f.qualified_name.includes(n));
    expect(find('main')?.verdict).toBe('live');
    expect(find('format')?.verdict).toBe('live');
    expect(find('neverCalled')?.verdict).toBe('dead');
  });

  it('removal_reach answers a Java pin pair in the same shape', async () => {
    const out = parse(await makeRemovalReachHandler()({ project_root: jhead, baseline_root: jbase }));
    expect(out.scheme).toBe('removal-reach@0.1');
    const names = (out.removed as any[]).map(r => r.qualified_name);
    expect(names.some(n => n.includes('neverCalled'))).toBe(true);
    expect(names.some(n => n.includes('format'))).toBe(false);
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
    const t = parse(await makeFindDeadCodeHandler()({ project_root: mixed, language: 'typescript' }));
    expect((t.facts as any[]).every(f => !f.file.endsWith('.java'))).toBe(true);
  });
});
