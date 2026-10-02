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

export function textResult(payload: object | string, structured?: Record<string, unknown>): ToolResult {
  // `provenance` goes last, so the fields a reader came for stay first.
  const text =
    typeof payload === 'string' ? payload : JSON.stringify({ ...payload, provenance: DETERMINISTIC }, null, 2);
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (structured) result.structuredContent = structured;
  return result;
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
