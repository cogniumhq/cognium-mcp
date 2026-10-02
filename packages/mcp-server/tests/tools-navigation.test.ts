/**
 * `find_callers` / `find_callees` — the tool surface over the engine's
 * navigation index.
 *
 * What these tests are for, beyond "the handler returns something": the two
 * tools' responses are compared field for field against a compiler-backed
 * oracle by an evaluation pack outside this repository. So the thing worth
 * pinning is not the happy path but the contract —
 *
 *   - the answer-shape fields arrive **unchanged**: nothing here renames,
 *     reorders inside, or drops a field the pack reads;
 *   - a tier is never upgraded by passing through this layer;
 *   - a truncated list says so, with the real total;
 *   - the envelope this tool adds (`projectRoot`, `cacheHit`, `nextStep`,
 *     `provenance`) is distinguishable from the answer itself.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProjectCache } from '../src/cache.js';
import { floorEnablement } from '../src/enablement.js';
import type { ToolContext } from '../src/tools/types.js';
import {
  makeFindCallersHandler,
  makeFindCalleesHandler,
  findCallersConfig,
  findCalleesConfig,
  nextStepFor,
  MAX_NAVIGATION_ANSWERS,
} from '../src/tools/navigation.js';

function payload(result: { content: Array<{ text: string }> }): Record<string, never> {
  return JSON.parse(result.content[0].text) as Record<string, never>;
}

const FILES: Record<string, string> = {
  'app/Greeter.java': `package app;
public interface Greeter { String greet(String who); }`,
  'app/Polite.java': `package app;
public class Polite implements Greeter { public String greet(String who) { return "hello " + who; } }`,
  'app/Blunt.java': `package app;
public class Blunt implements Greeter { public String greet(String who) { return "hi"; } }`,
  'app/Config.java': `package app;
public record Config(String host) {
  public String url(String path) { return host + path; }
}`,
  'app/Caller.java': `package app;
import java.util.ArrayList;
public class Caller {
  private final Config cfg = new Config("example.test");
  String viaInterface(Greeter g) { return g.greet("you"); }
  String viaClass(Polite p) { return p.greet("you"); }
  String viaRecord() { return cfg.url("/health"); }
  int viaLibrary() { ArrayList<String> xs = new ArrayList<>(); return xs.size(); }
}`,
  // A second and third interface-typed call site, so a cap of 1 has something
  // to cut. Without them the truncation test would assert nothing.
  'app/Again.java': `package app;
public class Again {
  String once(Greeter g) { return g.greet("a"); }
  String twice(Greeter g) { return g.greet("b"); }
}`,
};

describe('find_callers / find_callees', () => {
  let root: string;
  let ctx: ToolContext;
  let callers: ReturnType<typeof makeFindCallersHandler>;
  let callees: ReturnType<typeof makeFindCalleesHandler>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cognium-mcp-nav-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    for (const [rel, src] of Object.entries(FILES)) writeFileSync(join(root, rel), src, 'utf8');
    ctx = { cache: new ProjectCache(2), enablement: floorEnablement() };
    callers = makeFindCallersHandler(ctx);
    callees = makeFindCalleesHandler(ctx);
  });

  it('declares itself read-only and closed-world', () => {
    for (const config of [findCallersConfig, findCalleesConfig]) {
      expect(config.annotations.readOnlyHint).toBe(true);
      expect(config.annotations.destructiveHint).toBe(false);
      expect(config.annotations.openWorldHint).toBe(false);
    }
  });

  it('says `deterministic` on every successful response', async () => {
    const p = payload(await callers({ project_root: root, symbol: 'app.Config.url' }));
    expect(p.provenance).toBe('deterministic');
  });

  it('passes the answer-shape fields through unchanged', async () => {
    const p = payload(await callers({ project_root: root, symbol: 'app.Config.url' }));
    // Every field the pack reads, present and named as the pack names it.
    expect(Object.keys(p)).toEqual(
      expect.arrayContaining(['query', 'answers', 'unresolved', 'scope', 'timing']),
    );
    expect(p.query).toEqual({ kind: 'callers', symbol: 'app.Config.url' });
    expect(Object.keys(p.scope as object).sort()).toEqual(['excluded', 'searched']);
    expect(Object.keys(p.timing as object).sort()).toEqual(['indexMs', 'parseMs', 'queryMs']);
  });

  it('answers a call on a record receiver, which the engine sees only when asked', async () => {
    const p = payload(await callers({ project_root: root, symbol: 'app.Config.url' }));
    const answers = p.answers as Array<{ target: string; tier: string; methodName: string }>;
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ target: 'app.Config.url', tier: 'exact', methodName: 'url' });
  });

  it('reports an interface receiver as polymorphic, with every candidate', async () => {
    const p = payload(await callees({ project_root: root, symbol: 'app.Caller.viaInterface' }));
    const answers = p.answers as Array<{ target: string; tier: string; candidates?: string[] }>;
    expect(answers).toHaveLength(1);
    expect(answers[0].target).toBe('app.Greeter.greet');
    expect(answers[0].tier).toBe('polymorphic');
    expect(answers[0].candidates?.sort()).toEqual(['app.Blunt.greet', 'app.Polite.greet']);
  });

  it('gives a library call an `external` reason rather than no explanation', async () => {
    const p = payload(await callees({ project_root: root, symbol: 'app.Caller.viaLibrary' }));
    const unresolved = p.unresolved as Array<{ methodName: string; reason: string }>;
    expect(unresolved.find((u) => u.methodName === 'size')?.reason).toBe('external');
  });

  it('states its denominator: files searched, languages, and what was skipped', async () => {
    const p = payload(await callers({ project_root: root, symbol: 'app.Config.url' }));
    const scope = p.scope as { searched: { files: number; languages: string[] }; excluded: unknown[] };
    expect(scope.searched.files).toBe(Object.keys(FILES).length);
    expect(scope.searched.languages).toEqual(['java']);
    // The directories the walk never entered are named, not implied.
    expect(scope.excluded.length).toBeGreaterThan(0);
    expect(JSON.stringify(scope.excluded)).toContain('node_modules');
  });

  it('carries a real parse reading, not a zero', async () => {
    const p = payload(await callers({ project_root: root, symbol: 'app.Config.url' }));
    const timing = p.timing as { parseMs: number };
    expect(timing.parseMs).toBeGreaterThan(0);
  });

  it('flags truncation with the real total', async () => {
    const full = payload(await callers({ project_root: root, symbol: 'app.Greeter.greet' }));
    const total = (full.answers as unknown[]).length;
    expect(total).toBeGreaterThan(1);          // the cap has something to cut
    expect(full.truncated).toBeUndefined();    // and an uncut list does not claim one

    const capped = payload(
      await callers({ project_root: root, symbol: 'app.Greeter.greet', limit: 1 }),
    );
    expect(capped.answers).toHaveLength(1);
    expect(capped.truncated).toEqual({ returned: 1, total });
  });

  it('filters by tier without changing the scope', async () => {
    const all = payload(await callees({ project_root: root, symbol: 'app.Caller.viaInterface' }));
    const exactOnly = payload(
      await callees({ project_root: root, symbol: 'app.Caller.viaInterface', tiers: ['exact'] }),
    );
    expect((all.answers as unknown[]).length).toBeGreaterThan(0);
    expect(exactOnly.answers).toHaveLength(0);
    expect(exactOnly.scope).toEqual(all.scope);
  });

  it('resolves a site to a symbol with (file, line, method name)', async () => {
    const p = payload(
      await callers({
        project_root: root,
        site: { file: 'app/Caller.java', line: 5, method_name: 'greet' },
      }),
    );
    expect(p.resolvedSymbol).toBe('app.Greeter.greet');
    expect((p.answers as unknown[]).length).toBeGreaterThan(0);
  });

  it('refuses a query that names both a symbol and a site, and one that names neither', async () => {
    const both = await callers({
      project_root: root,
      symbol: 'app.Config.url',
      site: { file: 'app/Caller.java', line: 5, method_name: 'greet' },
    });
    expect(both.isError).toBe(true);
    const neither = await callers({ project_root: root });
    expect(neither.isError).toBe(true);
  });

  it('uses the cache on a second query of the same project', async () => {
    const first = payload(await callers({ project_root: root, symbol: 'app.Config.url' }));
    const second = payload(await callers({ project_root: root, symbol: 'app.Polite.greet' }));
    expect(first.cacheHit === false || second.cacheHit === true).toBe(true);
    expect(second.cacheHit).toBe(true);
  });

  it('defaults the cap to MAX_NAVIGATION_ANSWERS', () => {
    expect(MAX_NAVIGATION_ANSWERS).toBe(200);
  });
});

describe('the denominator is honest on a mixed-language project', () => {
  // The first graded record's `:denominator-stated` deviation was observed
  // here, on the server's own answer: the walk collects every language it can
  // detect, so a repository with TypeScript and Python next to Java had the
  // answer claiming four languages searched while one was resolved. A caller
  // dividing answers by files searched got a ratio about nothing.
  let root: string;
  let ctx: ToolContext;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cognium-mcp-mixed-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(join(root, 'web'), { recursive: true });
    for (const [rel, src] of Object.entries(FILES)) writeFileSync(join(root, rel), src, 'utf8');
    writeFileSync(
      join(root, 'web', 'app.ts'),
      'export function hello(n: string) { return greet(n); }\nfunction greet(n: string) { return "hi " + n; }\n',
      'utf8',
    );
    writeFileSync(join(root, 'web', 'run.py'), 'def main():\n    return helper()\ndef helper():\n    return 2\n', 'utf8');
    ctx = { cache: new ProjectCache(2), enablement: floorEnablement() };
  });

  it('names only the language it resolves, and counts only those files', async () => {
    const p = payload(await makeFindCallersHandler(ctx)({ project_root: root, symbol: 'app.Config.url' }));
    const scope = p.scope as { searched: { files: number; languages: string[] } };

    expect(scope.searched.languages).toEqual(['java']);
    expect(scope.searched.files).toBe(Object.keys(FILES).length);
  });

  it('declines the other languages by name, with the vocabulary reason', async () => {
    const p = payload(await makeFindCallersHandler(ctx)({ project_root: root, symbol: 'app.Config.url' }));
    const scope = p.scope as { excluded: Array<{ pattern: string; reason: string }> };

    const declined = scope.excluded.filter((e) => e.reason.startsWith('unsupported-language'));
    expect(declined.map((e) => e.pattern).sort()).toEqual(['python', 'typescript']);
    for (const e of declined) expect(e.reason).toContain('java');
  });

  it('still answers correctly about the language it does resolve', async () => {
    const p = payload(await makeFindCallersHandler(ctx)({ project_root: root, symbol: 'app.Config.url' }));
    expect((p.answers as unknown[]).length).toBe(1);
  });
});

describe('the suggested next step', () => {
  const base = {
    query: { kind: 'callers' as const, symbol: 'x' },
    scope: { searched: { files: 1, languages: ['java'] }, excluded: [] },
    timing: { parseMs: 1, indexMs: 1, queryMs: 1 },
  };
  const answer = (answers: unknown[], unresolved: unknown[] = []): never =>
    ({ ...base, answers, unresolved }) as never;

  it('says nothing when an answer is exact — there is nothing to advise', () => {
    expect(nextStepFor(answer([{ tier: 'exact' }]), 'callers')).toBeUndefined();
  });

  it('points at the candidates when dispatch is open', () => {
    const hint = nextStepFor(answer([{ tier: 'polymorphic' }]), 'callers');
    expect(hint).toContain('candidates');
  });

  it('tells the reader an inferred hit is a lead, and names the better tool', () => {
    const hint = nextStepFor(answer([{ tier: 'inferred' }]), 'callers');
    expect(hint).toContain('method name');
    expect(hint).toContain('language server');
  });

  it('says the call graph is insufficient when the target is in the tree and unbound', () => {
    const hint = nextStepFor(answer([], [{ reason: 'unknown' }]), 'callers');
    expect(hint).toContain('insufficient');
  });

  it('explains an all-external result rather than looking like a failure', () => {
    const hint = nextStepFor(answer([], [{ reason: 'external' }, { reason: 'external' }]), 'callers');
    expect(hint).toContain('outside');
    expect(hint).toContain('scope');
  });

  it('tells the reader to check the spelling when nothing was found at all', () => {
    const hint = nextStepFor(answer([], []), 'callees');
    expect(hint).toContain('fully qualified');
    expect(hint).toContain('callees');
  });
});
