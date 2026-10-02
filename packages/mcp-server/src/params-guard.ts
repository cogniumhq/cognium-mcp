/**
 * Answer a request with bad parameters with the code reserved for it.
 *
 * JSON-RPC reserves `-32602` (Invalid params) for a request the server can
 * read and whose parameters are wrong. The SDK validates a request's shape
 * inside its handler and reports a failure there as `-32603` (Internal
 * error), with the validator's raw issue list as the message — the wrong
 * code, and a message written for the SDK's authors rather than the caller.
 *
 * This checks the shape first, against the SDK's own request schemas, and
 * replies `-32602` with one line that names the offending field. It only
 * ever acts on a request it is certain is malformed; everything else goes
 * to the SDK untouched, so a request the SDK accepts is never refused here.
 *
 * It covers the methods this server serves. A method it has no schema for
 * is passed through, and the SDK answers it — `-32601` if it is unknown.
 */

import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/core";
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/server";
import { ProtocolErrorCode } from "@modelcontextprotocol/server";

interface Issue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

interface RequestSchema {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: ReadonlyArray<Issue> } };
}

const SCHEMAS: Readonly<Record<string, RequestSchema>> = {
  'tools/call': CallToolRequestSchema,
  'tools/list': ListToolsRequestSchema,
  'resources/list': ListResourcesRequestSchema,
  'resources/templates/list': ListResourceTemplatesRequestSchema,
  'resources/read': ReadResourceRequestSchema,
};

/** One line naming the first field that is wrong. */
function describe(method: string, issues: ReadonlyArray<Issue>): string {
  const first = issues[0];
  const where = first.path.map(String).join('.') || 'params';
  return `Invalid params for ${method}: ${where}: ${first.message}`;
}

/**
 * The `-32602` reply for a message, or `null` if the message should go to
 * the SDK as it is. Exported for the tests; `guardParams` is what a server
 * uses.
 */
export function invalidParamsReply(message: unknown): JSONRPCMessage | null {
  if (typeof message !== 'object' || message === null) return null;
  const { id, method } = message as { id?: unknown; method?: unknown };
  // Only requests are answered: a notification has no id and gets no reply.
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof method !== 'string') return null;

  const schema = SCHEMAS[method];
  if (!schema) return null;
  const parsed = schema.safeParse(message);
  if (parsed.success) return null;

  return {
    jsonrpc: '2.0',
    id,
    error: { code: ProtocolErrorCode.InvalidParams, message: describe(method, parsed.error.issues) },
  };
}

/**
 * Put the check in front of a connected transport. Call it after
 * `server.connect(transport)`, which is when the SDK installs the handler
 * this wraps.
 */
export function guardParams(transport: Transport): void {
  const inner = transport.onmessage;
  if (!inner) return;
  transport.onmessage = (message, extra) => {
    const reply = invalidParamsReply(message);
    if (reply) {
      void transport.send(reply);
      return;
    }
    inner(message, extra);
  };
}
