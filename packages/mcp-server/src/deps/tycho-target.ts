/**
 * Maven locations of an Eclipse PDE / Tycho target platform (`*.target`).
 *
 * On an Eclipse-based build (Tycho) the third-party versions live in
 * `<location type="Maven">` entries of a target definition, not in pom
 * `<dependency>` rows, so a tree read from its poms alone finds none of them.
 * Both forms are read: the flat `groupId` / `artifactId` / `version` location,
 * and the `<dependencies><dependency>` list inside one location. Comments and
 * CDATA are ignored; other location types (`InstallableUnit`, `Target`,
 * `Directory`) are skipped. A version that is a `${…}` property is `unknown`.
 *
 * The rules are those of circle-ir's `parseTychoTargetDependencies`
 * (cognium-dev #1077), which is not in a released circle-ir yet; switch to
 * that export when the pin moves past 4.19.0. Coordinates are handed to
 * circle-ir's `parseMavenDependencies` so names, versions and purls are built
 * exactly as for a pom row.
 */

import { parseMavenDependencies, type Dependency } from 'circle-ir';

export interface TargetCoordinate {
  groupId: string;
  artifactId: string;
  /** The declared version, or `unknown` (absent, or a `${…}` property). */
  version: string;
}

const tag = (block: string, name: string): string | undefined =>
  new RegExp(`<${name}>\\s*([^<\\s]+)\\s*</${name}>`).exec(block)?.[1];

/** The `g:a:v` of every Maven location in a target definition, in file order. */
export function tychoTargetCoordinates(targetXml: string): TargetCoordinate[] {
  if (!targetXml) return [];
  const text = targetXml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const out: TargetCoordinate[] = [];
  const coord = (block: string): void => {
    const groupId = tag(block, 'groupId');
    const artifactId = tag(block, 'artifactId');
    if (!groupId || !artifactId) return;
    let version = tag(block, 'version') ?? 'unknown';
    if (version.includes('${')) version = 'unknown';
    out.push({ groupId, artifactId, version });
  };
  const locRe = /<location\b([^>]*)>([\s\S]*?)<\/location>/g;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(text)) !== null) {
    if (!/\btype\s*=\s*["']Maven["']/i.test(m[1])) continue;
    const body = m[2];
    const deps = body.match(/<dependency>[\s\S]*?<\/dependency>/g);
    if (deps) for (const d of deps) coord(d);
    else coord(body);
  }
  return out;
}

/** The target's Maven locations as dependencies (`required` scope), one per location entry. */
export function parseTychoTarget(targetXml: string): Dependency[] {
  return tychoTargetCoordinates(targetXml).flatMap((c) => {
    const version = c.version === 'unknown' ? '' : `<version>${c.version}</version>`;
    const pom = `<project><dependencies><dependency><groupId>${c.groupId}</groupId>` +
      `<artifactId>${c.artifactId}</artifactId>${version}</dependency></dependencies></project>`;
    return parseMavenDependencies(pom).map((d) => ({ ...d, scope: 'required' as const }));
  });
}

/** A target definition file: `name.target`, not a bare `.target`. */
export const isTychoTarget = (fileName: string): boolean => fileName.endsWith('.target') && fileName !== '.target';
