/**
 * Advisory snapshot: a directory of OSV records (as `unzip Maven/all.zip`
 * leaves it), read once per content and kept indexed in memory.
 *
 * The snapshot is an input the caller pins; this module never downloads
 * anything. Its identity is a digest over the records it holds, so the same
 * records give the same digest wherever they are unpacked, and the answer can
 * carry it for the caller to record.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildAdvisoryIndex, parseOsvRecord, type AdvisoryIndex, type OsvRecord } from 'circle-ir';

export interface Snapshot {
  /** Absolute path the snapshot was read from. */
  path: string;
  /** `sha256:<hex>` over the sorted `<file name>\0<sha256 of file>\n` lines. */
  digest: string;
  /** JSON files read (records and non-records alike). */
  files: number;
  index: AdvisoryIndex;
}

export class SnapshotError extends Error {}

function jsonFiles(dir: string): string[] {
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) throw new SnapshotError(`advisory_db is not a directory: ${dir}`);
    names = readdirSync(dir);
  } catch (err) {
    if (err instanceof SnapshotError) throw err;
    throw new SnapshotError(`advisory_db not found: ${dir}`);
  }
  return names.filter((n) => n.endsWith('.json')).sort();
}

function statKeyOf(dir: string, names: string[]): string {
  const h = createHash('sha256');
  for (const n of names) {
    const s = statSync(join(dir, n));
    h.update(`${n}\0${s.size}\0${s.mtimeMs}\n`);
  }
  return h.digest('hex');
}

/**
 * Snapshots indexed so far, keyed by digest: the same records unpacked in two
 * places (a head tree and a baseline tree each carrying a copy) are indexed
 * once. A per-directory stat key spares re-hashing an unchanged directory.
 */
export class SnapshotCache {
  private readonly byDigest = new Map<string, AdvisoryIndex>();
  private readonly byDir = new Map<string, { statKey: string; digest: string; files: number }>();

  constructor(private readonly capacity = 2) {}

  /** Read (or reuse) the snapshot at `dir`. Throws `SnapshotError` with one line. */
  load(dir: string): { snapshot: Snapshot; cacheHit: boolean } {
    const names = jsonFiles(dir);
    const statKey = statKeyOf(dir, names);
    const known = this.byDir.get(dir);
    if (known && known.statKey === statKey) {
      const index = this.byDigest.get(known.digest);
      if (index) return { snapshot: { path: dir, digest: known.digest, files: known.files, index }, cacheHit: true };
    }

    const lines: string[] = [];
    const texts: string[] = [];
    for (const n of names) {
      const bytes = readFileSync(join(dir, n));
      lines.push(`${n}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
      texts.push(bytes.toString('utf8'));
    }
    const digest = `sha256:${createHash('sha256').update(lines.join('')).digest('hex')}`;
    this.byDir.set(dir, { statKey, digest, files: names.length });

    let index = this.byDigest.get(digest);
    const cacheHit = index !== undefined;
    if (!index) {
      const records: OsvRecord[] = [];
      for (const t of texts) {
        const r = parseOsvRecord(t);
        if (r) records.push(r);
      }
      if (records.length === 0) throw new SnapshotError(`advisory_db holds no OSV records: ${dir}`);
      index = buildAdvisoryIndex(records, 'Maven');
      this.byDigest.set(digest, index);
      while (this.byDigest.size > this.capacity) this.byDigest.delete(this.byDigest.keys().next().value as string);
    } else {
      this.byDigest.delete(digest);
      this.byDigest.set(digest, index);
    }
    return { snapshot: { path: dir, digest, files: names.length, index }, cacheHit };
  }

  clear(): number {
    const n = this.byDigest.size;
    this.byDigest.clear();
    this.byDir.clear();
    return n;
  }
}
