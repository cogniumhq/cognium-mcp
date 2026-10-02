/**
 * A tool module the server can load by specifier — plain JavaScript, because
 * the stdio door is the built binary and loads this with `import()`.
 *
 * It stands in for an optional module in the one-answer test: one tool that
 * is always listed, and one that is listed only with a configured endpoint.
 */

import { createRequire } from 'node:module';
import { z } from 'zod';

const circleIr = createRequire(import.meta.url)('circle-ir/package.json').version;

export const ALWAYS_TOOL = 'fixture_echo';
export const ENDPOINT_TOOL = 'fixture_endpoint_backed';

export default {
  id: 'fixture/one-answer',
  version: '1.0.0',
  licence: 'MIT',
  circleIrRange: circleIr,
  register(server, ctx) {
    server.registerTool(
      ALWAYS_TOOL,
      {
        title: 'Fixture echo',
        description: 'Returns its argument and the state it was registered under.',
        inputSchema: { text: z.string().describe('Text to echo back') },
        outputSchema: { text: z.string(), state: z.string(), provenance: z.string() },
      },
      async ({ text }) => {
        const body = { text, state: ctx.enablement.state, provenance: 'deterministic' };
        return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
      },
    );

    if (!ctx.enablement.endpoint) return;

    server.registerTool(
      ENDPOINT_TOOL,
      { description: 'Listed only when an endpoint is configured.', inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
  },
};
