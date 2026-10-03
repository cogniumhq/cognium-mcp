#!/usr/bin/env node
/**
 * The paired navigation trial: one agent run per (site, prompt, harness, config).
 *
 *   REPO=<webgoat at the pinned commit> node bench/agent-trial/run.mjs \
 *     --sample bench/agent-trial/sample.json --out results.json \
 *     [--harness claude,codex] [--sites 6] [--repeats 1]
 *
 * Paired by design: the same site and the same prompt are asked of the same
 * harness twice, once with the MCP server on stdio and once without it, so the
 * difference is the server and not the question. Order is randomised from the
 * seed so a warming cache or a rate limit cannot land systematically on one arm.
 *
 * **No prompt tuning.** The two prompts are fixed strings, identical in both
 * arms, and nothing here edits a tool description. The only difference between
 * arms is whether `--mcp-config` / `mcp_servers` is passed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1]]);
    return acc;
  }, []),
);
const REPO = process.env.REPO;
if (!REPO) throw new Error('set REPO to the pinned repository checkout');
const SERVER = process.env.SERVER ?? resolve('packages/mcp-server/dist/bin.js');
const SEED = Number(process.env.SEED ?? 20261002);
const harnesses = (args.harness ?? 'claude,codex').split(',');
const repeats = Number(args.repeats ?? 1);
const limitSites = args.sites ? Number(args.sites) : undefined;

/** The two prompts. Fixed; not tuned; identical in both arms. */
const PROMPTS = {
  callers: (t) => `list every caller of ${t} in this repository`,
  impact: (t) => `which files would change if ${t}'s signature changed`,
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mcpConfigPath = resolve(dirname(args.out ?? 'results.json'), 'mcp-config.generated.json');
mkdirSync(dirname(mcpConfigPath), { recursive: true });
writeFileSync(
  mcpConfigPath,
  JSON.stringify({
    mcpServers: { cognium: { command: 'node', args: [SERVER], env: { COGNIUM_MCP_MODULES: 'none' } } },
  }),
);

/** Claude Code headless. `stream-json` so the tool calls are visible. */
function runClaude(prompt, withMcp) {
  const argv = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (withMcp) {
    argv.push('--mcp-config', mcpConfigPath, '--strict-mcp-config',
      '--allowed-tools', 'mcp__cognium__find_callers,mcp__cognium__find_callees,Read,Grep,Glob,Bash');
  } else {
    // Same tool budget minus the server, so the arms differ only in the server.
    argv.push('--strict-mcp-config', '--allowed-tools', 'Read,Grep,Glob,Bash');
  }
  const t0 = Date.now();
  const r = spawnSync('claude', argv, { cwd: REPO, encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 28 });
  const wallMs = Date.now() - t0;
  const lines = (r.stdout ?? '').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tools = [];
  for (const m of lines) for (const c of m.message?.content ?? []) if (c.type === 'tool_use') tools.push(c.name);
  const fin = lines.find((m) => m.type === 'result');
  return {
    ok: r.status === 0 && !!fin,
    answer: String(fin?.result ?? ''),
    tools,
    usedFindCallers: tools.some((t) => /find_callers/.test(t)),
    tokensIn: (fin?.usage?.input_tokens ?? 0) + (fin?.usage?.cache_read_input_tokens ?? 0)
      + (fin?.usage?.cache_creation_input_tokens ?? 0),
    tokensOut: fin?.usage?.output_tokens ?? 0,
    costUsd: fin?.total_cost_usd ?? null,
    turns: fin?.num_turns ?? null,
    wallMs,
    error: r.status === 0 ? null : `exit ${r.status}${r.error ? `: ${r.error.message}` : ''}`,
  };
}

/** Codex CLI. The prompt goes on stdin; passing it as an argument hangs. */
function runCodex(prompt, withMcp) {
  const argv = ['exec', '--json', '--skip-git-repo-check'];
  if (withMcp) {
    argv.push('-c', 'mcp_servers.cognium.command="node"', '-c', `mcp_servers.cognium.args=["${SERVER}"]`);
  }
  const t0 = Date.now();
  const r = spawnSync('codex', argv, {
    cwd: REPO, input: `${prompt}\n`, encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 28,
  });
  const wallMs = Date.now() - t0;
  const lines = (r.stdout ?? '').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const whole = JSON.stringify(lines);
  const done = [...lines].reverse().find((m) => m.type === 'turn.completed');
  const texts = lines.flatMap((m) => {
    const it = m.item ?? m.msg?.item;
    const t = it?.text ?? it?.content?.map?.((c) => c.text).join('\n');
    return t ? [t] : [];
  });
  return {
    ok: r.status === 0 && !!done,
    answer: texts.join('\n'),
    tools: [...new Set((whole.match(/"name":"([a-z_]+)"/g) ?? []).map((s) => s.slice(8, -1)))],
    usedFindCallers: /find_callers/.test(whole),
    tokensIn: (done?.usage?.input_tokens ?? 0),
    tokensOut: (done?.usage?.output_tokens ?? 0),
    costUsd: null,                       // the Codex JSON reports no cost
    turns: null,
    wallMs,
    error: r.status === 0 ? null : `exit ${r.status}`,
  };
}

const RUNNERS = { claude: runClaude, codex: runCodex };

const sample = JSON.parse(readFileSync(args.sample, 'utf8'));
const sites = limitSites ? sample.sample.slice(0, limitSites) : sample.sample;

// Every run the matrix calls for, then shuffled from the seed.
const plan = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const site of sites) {
    for (const kind of Object.keys(PROMPTS)) {
      for (const harness of harnesses) {
        for (const config of ['baseline', 'with-mcp']) {
          plan.push({ repeat, target: site.target, kind, harness, config });
        }
      }
    }
  }
}
const rnd = mulberry32(SEED);
for (let i = plan.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [plan[i], plan[j]] = [plan[j], plan[i]];
}

const versions = {
  claude: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout?.trim(),
  codex: spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim(),
  server: JSON.parse(readFileSync('packages/mcp-server/package.json', 'utf8')).version,
  circleIr: JSON.parse(readFileSync('node_modules/circle-ir/package.json', 'utf8')).version,
  repoCommit: spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim(),
};

const runs = [];
let n = 0;
for (const item of plan) {
  n += 1;
  process.stderr.write(`[${n}/${plan.length}] ${item.harness} ${item.config} ${item.kind} ${item.target.split('.').slice(-2).join('.')}\n`);
  const prompt = PROMPTS[item.kind](item.target);
  const result = RUNNERS[item.harness](prompt, item.config === 'with-mcp');
  runs.push({ ...item, prompt, ...result });
  writeFileSync(args.out, JSON.stringify({ meta: { ...sample.meta, versions, planned: plan.length, seed: SEED }, runs }, null, 1));
}

process.stderr.write(`done: ${runs.length} runs, ${runs.filter((r) => !r.ok).length} failed\n`);
