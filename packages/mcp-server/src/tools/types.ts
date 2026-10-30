/**
 * Shared types for tool handlers.
 */

import type { ProjectCache } from '../cache.js';
import type { Enablement } from '../enablement.js';

export interface ToolContext {
  /** One analysis cache for the whole server, shared by every tool. */
  cache: ProjectCache;
  /**
   * What this install may offer. Present so an optional module can decide,
   * at registration time, which of its own tools to register, and check
   * again at call time before doing anything an endpoint or a licence is
   * needed for. The floor tools never consult it.
   */
  enablement: Enablement;
  /**
   * The directories tools may read (issue #37): their real paths, or
   * `'unconfined'`. The server has already checked every path argument
   * against these before a tool runs; a module that reads further paths of
   * its own (a path named inside a file, say) should hold them to the same
   * roots.
   */
  allowedRoots?: readonly string[] | 'unconfined';
}

/**
 * How a response was produced. Every tool in this package computes its
 * answer from static analysis alone, so every successful response says so.
 * An optional module that calls a model reports `llm: <model>` instead; a
 * client can rely on the field rather than infer it from the tool's name.
 */
export const DETERMINISTIC = 'deterministic';

/**
 * What the built-in tools declare about themselves. They read the project
 * they are pointed at and nothing else: no file is written or deleted and
 * nothing leaves the machine. A client may use these to decide whether a
 * call needs confirmation, so they are claims to keep true, not decoration.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * `refresh` drops entries from the server's in-memory analysis cache. It
 * touches no file, but it does change the server's state, so it does not
 * claim to be read-only.
 */
export const CACHE_RESET_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * MCP `CallToolResult`-compatible shape. We construct the JSON payload
 * ourselves so tools have full control over serialization + truncation.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * A tool's answer as both JSON text and `structuredContent`. An object
 * payload's structured copy is parsed back from the text, so the two are the
 * same object byte for byte (an `undefined` field is absent from both) and
 * every tool that declares an `outputSchema` returns what it validates
 * (issue #38). A string payload has no structured copy.
 */
export function textResult(payload: object | string, structured?: Record<string, unknown>): ToolResult {
  // `provenance` goes last, so the fields a reader came for stay first.
  const text =
    typeof payload === 'string' ? payload : JSON.stringify({ ...payload, provenance: DETERMINISTIC }, null, 2);
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (structured) result.structuredContent = structured;
  else if (typeof payload !== 'string') result.structuredContent = JSON.parse(text) as Record<string, unknown>;
  return result;
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
