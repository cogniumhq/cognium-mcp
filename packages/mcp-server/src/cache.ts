/**
 * Project-scoped analysis cache.
 *
 * A long-lived MCP process holds one `ProjectAnalysis` per active project
 * root. Invalidation is mtime-based: on each request we re-index file
 * mtimes and re-run `analyzeProject` only if any file changed. LRU
 * eviction keeps memory bounded when the LLM hops between projects.
 */

import { relative, resolve } from 'path';
import {
  analyze,
  analyzeProject,
  buildNavigationIndex,
  type NavigationIndex,
  type ProjectAnalysis,
} from 'circle-ir';
import { collectFiles, indexMtimes, mtimesEqual, SKIPPED_DIRECTORIES } from './util/files.js';
import { ensureAnalyzer } from './util/wasm.js';

/**
 * Per-project analysis options that participate in the cache key. Two
 * scans with different profiles / disabled passes must not share a cache
 * entry.
 */
export interface ProjectScanOptions {
  /** Force analysis of a single language. */
  language?: string;
  /** Circle-IR disabled passes (e.g. ['naming-convention']). */
  disabledPasses?: string[];
  /** Cross-file phase wall-time budget in ms. 0 = unlimited. */
  crossFileBudgetMs?: number;
}

interface CacheEntry {
  key: string;
  analysis: ProjectAnalysis;
  mtimes: Map<string, number>;
  computedAt: number;
  analysisMs: number;
}

interface NavigationEntry {
  key: string;
  index: NavigationIndex;
  mtimes: Map<string, number>;
  computedAt: number;
  /** Wall time spent producing the IR the index was built from. */
  parseMs: number;
  fileCount: number;
}

function optionsKey(opts: ProjectScanOptions): string {
  const parts = [
    `lang=${opts.language ?? '*'}`,
    `disabled=${(opts.disabledPasses ?? []).slice().sort().join(',')}`,
    `budget=${opts.crossFileBudgetMs ?? 'default'}`,
  ];
  return parts.join('|');
}

export class ProjectCache {
  private entries = new Map<string, CacheEntry>();
  private navEntries = new Map<string, NavigationEntry>();
  private readonly capacity: number;

  constructor(capacity = 3) {
    this.capacity = capacity;
  }

  private cacheKey(projectRoot: string, opts: ProjectScanOptions): string {
    return `${resolve(projectRoot)}::${optionsKey(opts)}`;
  }

  /**
   * Return a cached analysis if fresh, else run `analyzeProject`. The
   * boolean `cacheHit` in the return value lets tools surface cache
   * behaviour to callers.
   */
  async getOrCompute(
    projectRoot: string,
    opts: ProjectScanOptions,
  ): Promise<{ analysis: ProjectAnalysis; cacheHit: boolean; analysisMs: number; fileCount: number }> {
    await ensureAnalyzer();
    const absRoot = resolve(projectRoot);
    const key = this.cacheKey(absRoot, opts);
    const existing = this.entries.get(key);

    const langOpt = opts.language as ProjectScanOptions['language'];
    const currentMtimes = indexMtimes(absRoot, langOpt ? { language: langOpt as never } : {});

    if (existing && mtimesEqual(existing.mtimes, currentMtimes)) {
      // Touch for LRU: re-insert to move to the end of the Map's iteration order.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return {
        analysis: existing.analysis,
        cacheHit: true,
        analysisMs: existing.analysisMs,
        fileCount: currentMtimes.size,
      };
    }

    const files = collectFiles(absRoot, langOpt ? { language: langOpt as never } : {});
    const t0 = Date.now();
    const analysis = await analyzeProject(
      files.map(f => ({ code: f.code, filePath: f.filePath, language: f.language })),
      {
        ...(opts.disabledPasses ? { disabledPasses: opts.disabledPasses } : {}),
        ...(opts.crossFileBudgetMs !== undefined ? { crossFileBudgetMs: opts.crossFileBudgetMs } : {}),
      },
    );
    const analysisMs = Date.now() - t0;

    const entry: CacheEntry = {
      key,
      analysis,
      mtimes: currentMtimes,
      computedAt: Date.now(),
      analysisMs,
    };
    this.entries.set(key, entry);
    this.evictLRU();

    return { analysis, cacheHit: false, analysisMs, fileCount: files.length };
  }

  /**
   * Return a cached navigation index if fresh, else build one.
   *
   * Kept apart from `getOrCompute` on purpose, in both directions:
   *
   *   - **It asks the engine for more.** The index needs `navigationTypes`,
   *     which makes a Java `record` visible and keeps a nested type's nesting.
   *     Sharing an entry with the scan tools would hand them type information
   *     they do not expect, so the two never share one.
   *   - **It asks the engine to do less.** Navigation needs per-file IR and
   *     nothing else, so this runs `analyze` per file rather than
   *     `analyzeProject`, skipping the cross-file taint phase entirely. On a
   *     large repository that phase is the expensive part, and a caller
   *     asking "who calls this method" should not pay for taint analysis it
   *     will not read.
   *
   * `parseMs` is the measured wall time of that loop, which is parsing **and**
   * IR extraction — the two are one call and the server cannot separate them.
   * It is handed to the index so `timing.parseMs` carries a real reading
   * rather than a zero, and it over-reports pure parse time rather than
   * guessing at it.
   */
  async getOrComputeNavigation(
    projectRoot: string,
    opts: ProjectScanOptions = {},
  ): Promise<{
    index: NavigationIndex;
    cacheHit: boolean;
    parseMs: number;
    fileCount: number;
  }> {
    await ensureAnalyzer();
    const absRoot = resolve(projectRoot);
    const key = `${absRoot}::nav::${optionsKey(opts)}`;
    const langOpt = opts.language as ProjectScanOptions['language'];
    const collectOpts = langOpt ? { language: langOpt as never } : {};
    const currentMtimes = indexMtimes(absRoot, collectOpts);

    const existing = this.navEntries.get(key);
    if (existing && mtimesEqual(existing.mtimes, currentMtimes)) {
      this.navEntries.delete(key);
      this.navEntries.set(key, existing);
      return {
        index: existing.index,
        cacheHit: true,
        parseMs: existing.parseMs,
        fileCount: existing.fileCount,
      };
    }

    const files = collectFiles(absRoot, collectOpts);
    const t0 = Date.now();
    const navFiles = [];
    for (const f of files) {
      navFiles.push({
        // Paths are reported relative to the project root, so an answer does
        // not leak the absolute layout of the machine it was produced on and
        // two runs from different checkouts of the same commit agree.
        path: relative(absRoot, f.filePath) || f.filePath,
        language: f.language,
        source: f.code,
        ir: await analyze(f.code, f.filePath, f.language, { navigationTypes: true }),
      });
    }
    const parseMs = Date.now() - t0;

    const index = buildNavigationIndex(navFiles, {
      parseMs,
      cache: true,
      excluded: SKIPPED_DIRECTORIES.map((d) => ({
        pattern: `**/${d}/**`,
        reason: 'not project source',
      })),
    });

    this.navEntries.set(key, {
      key,
      index,
      mtimes: currentMtimes,
      computedAt: Date.now(),
      parseMs,
      fileCount: files.length,
    });
    this.evictLRU();

    return { index, cacheHit: false, parseMs, fileCount: files.length };
  }

  /** Invalidate one specific project (all option-keys) or one specific key. */
  invalidate(projectRoot: string, opts?: ProjectScanOptions): number {
    const abs = resolve(projectRoot);
    let removed = 0;
    if (opts) {
      if (this.entries.delete(this.cacheKey(abs, opts))) removed++;
      return removed;
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(abs + '::')) {
        this.entries.delete(key);
        removed++;
      }
    }
    for (const key of [...this.navEntries.keys()]) {
      if (key.startsWith(abs + '::')) {
        this.navEntries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Invalidate every cached project. */
  clear(): number {
    const n = this.entries.size + this.navEntries.size;
    this.entries.clear();
    this.navEntries.clear();
    return n;
  }

  size(): number {
    return this.entries.size + this.navEntries.size;
  }

  private evictLRU(): void {
    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    // Navigation indexes are evicted on their own budget: a project can hold
    // one of each, and evicting a scan entry must not drop a navigation index
    // the caller is still querying.
    while (this.navEntries.size > this.capacity) {
      const oldestKey = this.navEntries.keys().next().value;
      if (oldestKey === undefined) break;
      this.navEntries.delete(oldestKey);
    }
  }
}
