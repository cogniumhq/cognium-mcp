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
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
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
const kinds = (args.prompts ?? 'callers,impact').split(',');
// Which arms to run. The whole matrix is the default; a subset exists so a
// cell can be added under a budget cap without re-running what is already
// measured, and the subset is recorded in `meta` so a partial file never reads
// as a complete one.
const wantVariants = args.variants ? args.variants.split(',') : null;
/** Stop before a run that would take the Claude meter past this. */
const budgetUsd = args.budget ? Number(args.budget) : Infinity;

/**
 * The arms.
 *
 *   baseline   no server at all
 *   published  the server as published (0.5.0 descriptions)
 *   described  descriptions only: each tool opens with the question it answers
 *              and says to call it before grepping. No behaviour, tool-list or
 *              schema change — the publish gate passes on it.
 *   hooked     `described` plus a Claude Code PostToolUse hook that suggests
 *              find_callers once after a Read or Grep over Java.
 *   agentsmd   the PUBLISHED server plus an AGENTS.md in the repository naming
 *              find_callers and when to use it. Codex's equivalent of the hook:
 *              it has no hook mechanism, but it does read AGENTS.md. Paired
 *              against `published`, which is the same server with no AGENTS.md,
 *              so the file is the only thing that differs.
 *
 * Each of the last two is applicable to exactly one harness, and the runner
 * SKIPS the inapplicable cell rather than running it and recording a zero: a
 * zero would read as "the lever did not work" where the lever was never
 * delivered. `hooked` is Claude-only, `agentsmd` is Codex-only.
 */
const SERVER_PUBLISHED = process.env.SERVER_PUBLISHED ?? SERVER;
const VARIANTS = {
  baseline: { mcp: false, hook: false, server: null },
  // The published 0.5.0 bin, installed from the registry — not this worktree's
  // build, so `published` really is the shipped descriptions.
  published: { mcp: true, hook: false, server: SERVER_PUBLISHED },
  described: { mcp: true, hook: false, server: SERVER },
  hooked: { mcp: true, hook: true, server: SERVER },
  agentsmd: { mcp: true, hook: false, server: SERVER_PUBLISHED, agentsMd: true },
};
const CLAUDE_ONLY = new Set(['hooked']);
const CODEX_ONLY = new Set(['agentsmd']);

/** Where the AGENTS.md lever is written, and what it says. */
const AGENTS_MD = resolve(REPO, 'AGENTS.md');
const AGENTS_MD_LINE = [
  '# Repository guidance',
  '',
  '## Finding callers of a Java method',
  '',
  'This repository has a Cognium MCP server. To answer "who calls this method?" —',
  'and before grepping for a method name — call the `find_callers` tool with the',
  "method's symbol. It answers from a call graph and labels how sure it is of each",
  'answer, where a text search finds the name rather than the calls. Use',
  '`find_callees` for what a method calls.',
  '',
].join('\n');

/**
 * The two prompts. Identical in every arm, and asked of every variant.
 *
 * Phase 7 rewrote them to ask for an **enumerated list of file paths**. Phase 6
 * asked open questions, and a third of the answers came back as prose — "246
 * call sites across 109 files, all under src/main/java/…/lessons/" — which
 * names no path a file-set grader can match, so those runs were unscoreable.
 * Asking for the list is grading design: it tells the agent what SHAPE of
 * answer is wanted and nothing about HOW to find it, it says nothing about any
 * tool, and it is the same text in the baseline arm as in the MCP arms.
 */
const PROMPTS = {
  callers: (t) =>
    `List every caller of ${t} in this repository. ` +
    'Answer with an enumerated list of the file paths containing the calls, one path per line, ' +
    'each relative to the repository root and ending in .java. Give the paths themselves, not a count.',
  impact: (t) =>
    `Which files would change if ${t}'s signature changed? ` +
    'Answer with an enumerated list of the file paths, one path per line, each relative to the ' +
    'repository root and ending in .java. Give the paths themselves, not a count.',
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

mkdirSync(dirname(args.out ?? 'results.json'), { recursive: true });
/** One MCP config per server build, so an arm cannot silently use the other's. */
const mcpConfigFor = (server) => {
  const path = resolve(dirname(args.out ?? 'results.json'),
    `mcp-config.${server === SERVER_PUBLISHED && server !== SERVER ? 'published' : 'worktree'}.generated.json`);
  writeFileSync(path, JSON.stringify({
    mcpServers: { cognium: { command: 'node', args: [server], env: { COGNIUM_MCP_MODULES: 'none' } } },
  }));
  return path;
};

/**
 * Claude Code settings carrying the plugin's PostToolUse hook, for the `hooked`
 * arm only. Written here rather than installed, so the other arms are provably
 * unaffected by it.
 */
const hookSettingsPath = resolve(dirname(args.out ?? 'results.json'), 'hook-settings.generated.json');
writeFileSync(
  hookSettingsPath,
  JSON.stringify({
    hooks: {
      PostToolUse: [
        {
          matcher: 'Read|Grep',
          hooks: [{ type: 'command', command: `node ${resolve('plugins/cognium-dev/hooks/suggest-find-callers.mjs')}` }],
        },
      ],
    },
  }),
);

/** Claude Code headless. `stream-json` so the tool calls are visible. */
function runClaude(prompt, withMcp, withHook, server) {
  // `--include-hook-events` always, not only in the hooked arm: it is the
  // authoritative record of whether a hook ran, and in the other arms it is
  // the proof that none did.
  //
  // It is here because of a mistake worth keeping: the hook's own latch file
  // was used as the trace first, `ls /tmp/...` found nothing, and the
  // conclusion drawn was that hooks do not execute under `claude -p`. They do.
  // `os.tmpdir()` on macOS is /var/folders/.../T, not /tmp, so the check
  // looked in the wrong directory — the instrument was wrong, not the subject,
  // and variant (c) was nearly dropped on the strength of it.
  const argv = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-hook-events'];
  if (withHook) argv.push('--settings', hookSettingsPath);
  if (withMcp) {
    argv.push('--mcp-config', mcpConfigFor(server), '--strict-mcp-config',
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
  // Whether the server was AVAILABLE, recorded separately from whether it was
  // USED. Without this a server that failed to start looks exactly like an
  // agent that chose not to call the tool, and the difference between those
  // two is the whole of the tool-selection finding.
  const init = lines.find((m) => m.type === 'system' && m.subtype === 'init');
  const servers = init?.mcp_servers ?? [];
  const hookRuns = lines.filter((m) => m.type === 'system' && m.subtype === 'hook_started');
  const hookResponses = lines.filter((m) => m.type === 'system' && m.subtype === 'hook_response');
  const suggested = hookResponses.some((m) => /find_callers/.test(String(m.output ?? '')));
  return {
    ok: r.status === 0 && !!fin,
    answer: String(fin?.result ?? ''),
    tools,
    serverAvailable: servers.some((s) => s.status === 'connected'),
    servers,
    hooksFired: hookRuns.length,
    hookSuggestedFindCallers: suggested,
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

/**
 * One attachment check per matrix: does the server reach Codex at all? Run once
 * and recorded in `meta`, because a per-run read is not available. Without it,
 * a Codex tool-selection rate of zero has two explanations and the bench cannot
 * say which.
 */
function probeCodexServer(server) {
  const r = spawnSync('codex', ['exec', '--json', '--skip-git-repo-check',
    '-c', 'mcp_servers.cognium.command="node"', '-c', `mcp_servers.cognium.args=["${server}"]`], {
    cwd: REPO, encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 26,
    input: 'Call the find_callers tool on target org.dummy.insecure.framework.VulnerableTaskHolder.toString '
      + 'and report the first line of its output. If you have no such tool, reply exactly: NO SUCH TOOL.\n',
  });
  const out = String(r.stdout ?? '');
  return {
    attached: /"type":"mcp_tool_call"/.test(out) && /"status":"completed"/.test(out),
    sawToolCall: /"type":"mcp_tool_call"/.test(out),
    exit: r.status,
  };
}

/**
 * Codex CLI. The prompt goes on stdin; passing it as an argument hangs.
 *
 * Availability is NOT observable the way it is for Claude Code. Codex's stream
 * carries no init event listing its MCP servers, so there is nothing to read
 * per run; the only server evidence it emits is an `mcp_tool_call`, which is
 * use and not availability, and reading one as the other would make every
 * non-selection indistinguishable from a dead server. So `serverAvailable` is
 * recorded as `null` — not observable — rather than `false`, and attachment is
 * established once per matrix by `probeCodexServer()` into `meta`. An earlier
 * read of this field as falsy made a correctly-attached server look absent for
 * all twelve Codex MCP runs.
 */
function runCodex(prompt, withMcp, _withHook, server) {
  const argv = ['exec', '--json', '--skip-git-repo-check'];
  if (withMcp) {
    argv.push('-c', 'mcp_servers.cognium.command="node"', '-c', `mcp_servers.cognium.args=["${server}"]`);
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
    serverConfigured: !!withMcp,
    serverAvailable: null,               // not observable per run; see probeCodexServer
    mcpToolCalls: (whole.match(/"mcp_tool_call"/g) ?? []).length,
    // Deliberately over-inclusive: it matches the name anywhere in the stream,
    // including the agent's own prose. A false positive is visible on reading
    // the run; a false negative would understate selection, so a zero here is
    // the one direction this detector cannot manufacture.
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

/**
 * The fixture must carry no agent configuration of its own.
 *
 * A `.claude/` left in the repository under test delivers hooks and settings to
 * EVERY arm, which silently makes the variants identical. That happened here:
 * a debugging probe left `.claude/settings.json` in the checkout, and the
 * `published` arm came back reporting five hook firings. Checked rather than
 * remembered.
 */
for (const stray of ['.claude', '.mcp.json', '.codex', 'AGENTS.md']) {
  if (existsSync(resolve(REPO, stray))) {
    throw new Error(
      `the repository under test carries ${stray}, which would reach every arm and make the ` +
        'variants indistinguishable — remove it before running',
    );
  }
}

/**
 * The description each variant's server actually serves, read over stdio.
 *
 * Variant (b) IS a description change, so a stale `dist/` would serve 0.5.0's
 * text under the name `described` and the cell would silently measure the
 * variant it was meant to be compared against. After the first matrix there
 * was no artefact left that could prove which text had been served — every
 * `dist` file carried the mtime of a later rebuild — so the cell had to be run
 * again. This reads it instead of trusting the build order.
 */
function servedDescription(serverPath) {
  return new Promise((ok, fail) => {
    const child = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`${serverPath} did not answer tools/list in time`)); }, 60_000);
    child.stdout.on('data', (c) => {
      out += c;
      let msgs;
      try { msgs = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return; }
      const list = msgs.find((m) => m.id === 2);
      if (!list) return;
      clearTimeout(timer);
      child.kill();
      const t = (list.result?.tools ?? []).find((x) => x.name === 'find_callers');
      ok(t?.description ?? '');
    });
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-trial', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

/** The sentence variant (b) adds, and (a) must not have. */
const DESCRIBED_MARKER = 'THE QUESTION THIS ANSWERS';
const served = { worktree: await servedDescription(SERVER) };
if (SERVER_PUBLISHED !== SERVER) served.published = await servedDescription(SERVER_PUBLISHED);
if (!served.worktree.includes(DESCRIBED_MARKER)) {
  throw new Error(`the worktree server does not serve variant (b)'s description — build packages/mcp-server before running, or the 'described' arm measures 'published'`);
}
if (served.published && served.published.includes(DESCRIBED_MARKER)) {
  throw new Error("the published server already serves variant (b)'s description, so (a) and (b) are not distinct arms");
}

const sample = JSON.parse(readFileSync(args.sample, 'utf8'));
const sites = limitSites ? sample.sample.slice(0, limitSites) : sample.sample;

// Every run the matrix calls for, then shuffled from the seed.
const plan = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const site of sites) {
    for (const kind of kinds) {
      for (const harness of harnesses) {
        for (const variant of Object.keys(VARIANTS)) {
          if (wantVariants && !wantVariants.includes(variant)) continue;
          if (CLAUDE_ONLY.has(variant) && harness !== 'claude') continue;   // not applicable, not zero
          if (CODEX_ONLY.has(variant) && harness !== 'codex') continue;     // likewise
          plan.push({ repeat, target: site.target, kind, harness, variant, config: variant });
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

// Attachment for Codex, once, before the matrix: a per-run read is not
// available from its stream, so without this a Codex selection rate of zero
// cannot be told apart from a server that never started.
const codexServer = plan.some((i) => i.harness === 'codex' && VARIANTS[i.variant].mcp)
  ? probeCodexServer(SERVER)
  : { attached: null, reason: 'no Codex MCP arm in this matrix' };
if (codexServer.attached === false) {
  throw new Error('the Codex MCP arm cannot reach the server, so its tool-selection rate would measure the harness, not the choice');
}

const runs = [];
let n = 0;
let spent = 0;
let stoppedForBudget = null;
const save = () => writeFileSync(args.out, JSON.stringify({
  meta: { ...sample.meta, versions, planned: plan.length, seed: SEED, budgetUsd, spentUsd: spent, stoppedForBudget,
    servers: { worktree: SERVER, published: SERVER_PUBLISHED }, codexServer,
    // What this file actually covers, so a subset never reads as a full matrix.
    ran: { harnesses, kinds, variants: wantVariants ?? Object.keys(VARIANTS), sites: sites.length, repeats },
    // The served text each arm was actually given, so the variant is evidenced
    // by the file rather than by the order the build happened to run in.
    servedDescriptions: { worktree: served.worktree.slice(0, 160), published: served.published?.slice(0, 160) ?? '(same binary as worktree)' } },
  runs,
}, null, 1));
for (const item of plan) {
  n += 1;
  // The cap is checked BEFORE a run, against the mean cost so far, so the
  // budget is never exceeded by the run that discovers it.
  const meanCost = runs.length ? spent / runs.filter((r) => r.costUsd !== null).length || 0 : 0;
  if (spent + meanCost > budgetUsd) {
    stoppedForBudget = { spent, meanCost, atRun: n, of: plan.length };
    process.stderr.write(`STOPPED FOR BUDGET at run ${n}/${plan.length}: $${spent.toFixed(2)} spent, cap $${budgetUsd}\n`);
    break;
  }
  const { mcp, hook, server, agentsMd } = VARIANTS[item.variant];
  process.stderr.write(`[${n}/${plan.length}] $${spent.toFixed(2)} ${item.harness} ${item.variant} ${item.kind} ${item.target.split('.').slice(-2).join('.')}\n`);
  const prompt = PROMPTS[item.kind](item.target);

  // The AGENTS.md lever belongs to exactly one arm. It is written immediately
  // before that run and removed immediately after, and every other run asserts
  // it is absent — because a file left behind would reach every later arm and
  // make the variants indistinguishable, which is precisely how the Phase 7
  // `.claude/settings.json` contamination happened. Asserted, not remembered.
  if (agentsMd) writeFileSync(AGENTS_MD, AGENTS_MD_LINE);
  else if (existsSync(AGENTS_MD)) {
    throw new Error(`AGENTS.md is present for a ${item.variant} run, so the lever would leak into an arm that must not have it`);
  }
  // Read back from disk rather than trusting the write: this is the number the
  // leak check in the report is made of.
  const agentsMdPresent = existsSync(AGENTS_MD);
  const agentsMdNamesTool = agentsMdPresent && /find_callers/.test(readFileSync(AGENTS_MD, 'utf8'));

  let result;
  try {
    result = RUNNERS[item.harness](prompt, mcp, hook, server);
  } finally {
    if (agentsMd) rmSync(AGENTS_MD, { force: true });
  }
  spent += result.costUsd ?? 0;
  runs.push({ ...item, prompt, agentsMdPresent, agentsMdNamesTool, ...result });
  save();
}
// Also after the loop, because the budget stop sets its reason and breaks: the
// only write used to be the one inside the loop, so a matrix truncated by the
// cap recorded `stoppedForBudget: null` and read as a complete, shorter plan.
// The one fact the cap exists to report was the one it dropped.
save();

process.stderr.write(`done: ${runs.length} runs, ${runs.filter((r) => !r.ok).length} failed, $${spent.toFixed(2)} spent\n`);
