/**
 * What the server tells an MCP client about its optional modules (issue #26).
 *
 * A refused module used to be reported on one line of stderr and nowhere
 * else, so to a client a refused module looked exactly like a server that
 * never had those tools. Two client-visible signals now carry the same facts,
 * on both protocol eras (they are part of the `initialize` result and of
 * `server/discover`):
 *
 * - `capabilities.experimental["cognium/modules"]`: the structured record —
 *   the installed `circle-ir`, each loaded module, and each refusal with its
 *   reason and, for the usual version-skew refusal, the `circle-ir` the
 *   module was built against next to the one this server pins;
 * - `instructions`: one paragraph, present only when something was refused,
 *   because that is the field a client most often shows its user or model.
 *
 * Pure, like `startup.ts`: it turns facts into values, and `buildServer`
 * attaches them.
 */

import type { ModuleRefusal, ToolModule } from './modules.js';

/** The key under `capabilities.experimental`. */
export const MODULES_CAPABILITY = 'cognium/modules';

export interface LoadedModuleStatus {
  readonly id: string;
  readonly version: string;
  readonly licence: string;
  readonly circleIrRange: string;
}

export interface ModuleStatus {
  /** The `circle-ir` installed next to this server, which is the one it pins exactly. */
  readonly circleIr: string;
  readonly loaded: readonly LoadedModuleStatus[];
  readonly refused: readonly ModuleRefusal[];
}

export function moduleStatus(
  circleIr: string,
  loaded: readonly ToolModule[],
  refused: readonly ModuleRefusal[],
): ModuleStatus {
  return {
    circleIr,
    loaded: loaded.map((m) => ({ id: m.id, version: m.version, licence: m.licence, circleIrRange: m.circleIrRange })),
    refused: refused.map((r) => ({ ...r })),
  };
}

/** What is still served after a refusal: the floor, and any module that did load. */
export function stillServing(loadedIds: readonly string[]): string {
  return loadedIds.length === 0
    ? 'Serving the deterministic floor only.'
    : `Still serving the deterministic floor and ${loadedIds.join(', ')}.`;
}

/**
 * The `instructions` text, or `undefined` when nothing was refused — a
 * server whose modules all loaded, or that has none, says nothing extra.
 */
export function statusInstructions(status: ModuleStatus): string | undefined {
  if (status.refused.length === 0) return undefined;
  const each = status.refused.map((r) => {
    const skew =
      r.builtAgainst !== undefined
        ? ` (built against circle-ir ${r.builtAgainst}; this server pins circle-ir ${r.installed ?? status.circleIr})`
        : '';
    return `${r.specifier}: ${r.reason}${skew}`;
  });
  const one = status.refused.length === 1;
  const noun = one ? 'An optional tool module was' : 'Optional tool modules were';
  return (
    `${noun} refused at startup, so ${one ? 'its' : 'their'} tools are not listed. ${each.join('; ')}. ` +
    `${stillServing(status.loaded.map((m) => m.id))} ` +
    `The same facts are in capabilities.experimental["${MODULES_CAPABILITY}"].`
  );
}
