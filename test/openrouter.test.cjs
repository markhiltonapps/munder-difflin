'use strict';

// OpenRouter routing: model tiers (which engine + model does which job), the
// Settings "Test connection" probe, exact per-call cost through the proxy
// sidecar and into payroll, GPT-6.1 Sol's long-context price line, and the
// wiring that puts all of it in front of the owner and the orchestrator.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const T = loadTs('src/shared/modelTiers.ts');
const OR = loadTs('src/main/openrouter.ts');
const pricing = loadTs('src/main/pricing.ts');
const { foldPayroll } = loadTs('src/main/payroll.ts');
const { costSampleRow } = loadTs('src/main/hooks.ts');
const { buildWorkerLaunch } = loadTs('src/main/workerLaunch.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

// --- tiers ----------------------------------------------------------------------

test('a tier is an engine the app knows plus a clean model slug; anything else is unset', () => {
  assert.deepEqual(T.normalizeTier({ provider: 'opencode', model: ' openrouter/openai/gpt-6.1-sol ', effort: 'high', maxOutputTokens: 32000 }),
    { provider: 'opencode', model: 'openrouter/openai/gpt-6.1-sol', effort: 'high', maxOutputTokens: 32000 });
  assert.equal(T.normalizeTier({ provider: 'nope', model: 'x' }), undefined, 'unknown engine');
  assert.equal(T.normalizeTier({ provider: 'opencode', model: '' }), undefined, 'no model');
  assert.equal(T.normalizeTier({ provider: 'opencode', model: 'a b; rm -rf' }), undefined, 'shell characters never reach a command line');
  const t = T.normalizeTier({ provider: 'qwen', model: 'openai/gpt-6.1-sol', effort: 'ultra', maxOutputTokens: 5 });
  assert.deepEqual(t, { provider: 'qwen', model: 'openai/gpt-6.1-sol' }, 'bad effort and an absurd cap are dropped, the tier survives');
  assert.deepEqual(T.normalizeTiers({ worker: { provider: 'opencode', model: 'm' }, routine: null, junk: 1 }), { worker: { provider: 'opencode', model: 'm' } });
  assert.deepEqual(T.normalizeTiers(undefined), {});
});

test('roles sort into tiers the way helpers always sorted onto Haiku', () => {
  assert.equal(T.tierForRole('backend engineer'), 'worker');
  assert.equal(T.tierForRole('triage inbox'), 'routine');
  assert.equal(T.tierForRole('writer', ['summarize reports']), 'routine');
  assert.equal(T.tierForRole(undefined), 'worker');
});

test('tierMatching finds the tier an agent is actually running; OpenRouter slugs round-trip', () => {
  const tiers = T.SUGGESTED_TIERS;
  assert.equal(T.tierMatching(tiers, 'opencode', 'openrouter/openai/GPT-6.1-sol').effort, 'high');
  assert.equal(T.tierMatching(tiers, 'qwen', 'openrouter/openai/gpt-6.1-sol'), undefined, 'same model on another engine is not the tier');
  assert.equal(T.tierMatching(undefined, 'opencode', 'x'), undefined);
  assert.equal(T.openRouterModelId('openrouter/openai/gpt-6.1-sol'), 'openai/gpt-6.1-sol');
  assert.equal(T.openRouterModelId('openai/gpt-6.1-sol'), 'openai/gpt-6.1-sol');
  assert.equal(T.isOpenRouterModel('OPENROUTER/x/y'), true);
  assert.equal(T.isOpenRouterUrl('https://openrouter.ai/api/v1'), true);
  assert.equal(T.isOpenRouterUrl('http://localhost:11434/v1'), false);
  assert.equal(T.knownContextBudget('openrouter/openai/gpt-6.1-sol'), 272000);
  assert.equal(T.knownContextBudget('deepseek/deepseek-v4.1-flash'), undefined, 'never a guess');
  assert.notEqual(T.SUGGESTED_TIERS.worker.model, 'openrouter/openai/gpt-6.1-sol-pro', 'Pro spends several times the reasoning tokens for the same price per token');
});

// --- the probe --------------------------------------------------------------------

test('a probe asks OpenRouter for usage accounting, the tier effort and a small output cap', () => {
  const body = OR.buildProbeBody({ label: 'worker', model: 'openai/gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(body.usage, { include: true });
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.model, 'openai/gpt-6.1-sol');
  assert.ok(body.max_tokens <= 100);
  assert.equal(OR.buildProbeBody({ label: 'x', model: 'm' }).reasoning, undefined);
});

test('parseUsage reads OpenRouter usage accounting, cost included; missing pieces read as zero', () => {
  const u = OR.parseUsage({ usage: { prompt_tokens: 40, completion_tokens: 25, cost: 0.00031, prompt_tokens_details: { cached_tokens: 12, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 10 } } });
  assert.deepEqual(u, { promptTokens: 40, completionTokens: 25, cachedTokens: 12, cacheWriteTokens: 3, reasoningTokens: 10, cost: 0.00031 });
  assert.equal(OR.parseUsage({ usage: { prompt_tokens: 1 } }).cost, null);
  assert.equal(OR.parseUsage({}), undefined);
});

test('probeOne: the key goes only into the Authorization header and never into a result', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'openai/gpt-6.1-sol', choices: [{ message: { content: ' I am GPT-6.1 Sol; 17 × 23 = 391. ' } }], usage: { prompt_tokens: 30, completion_tokens: 18, cost: 0.00024 } }) };
  };
  const r = await OR.probeOne('sk-or-SECRET123', { label: 'worker', model: 'openai/gpt-6.1-sol', effort: 'high' }, fakeFetch);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'I am GPT-6.1 Sol; 17 × 23 = 391.');
  assert.equal(r.usage.cost, 0.00024);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-or-SECRET123');
  assert.doesNotMatch(JSON.stringify(r), /SECRET123/);

  const bad = await OR.probeOne('sk-or-SECRET123', { label: 'x', model: 'm' }, async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'bad key sk-or-SECRET123 rejected' } }) }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /HTTP 401/);
  assert.doesNotMatch(bad.error, /SECRET123/, 'error text is scrubbed');
  assert.equal((await OR.probeOne('', { label: 'x', model: 'm' }, fakeFetch)).error, 'no OpenRouter key set');
});

test('probeOpenRouter runs its specs one at a time and never more than six', async () => {
  let inFlight = 0, peak = 0, n = 0;
  const fakeFetch = async () => {
    inFlight++; peak = Math.max(peak, inFlight); n++;
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { cost: 0.000001 } }) };
  };
  const specs = Array.from({ length: 8 }, (_, i) => ({ label: `m${i}`, model: `m${i}` }));
  const out = await OR.probeOpenRouter('k', specs, fakeFetch);
  assert.equal(out.length, 6);
  assert.equal(n, 6);
  assert.equal(peak, 1);
});

// --- prices -------------------------------------------------------------------------

test('GPT-6.1 Sol: $2/$10 with $0.10 cached reads, and the whole request re-prices past 272k input', () => {
  const info = pricing.priceInfo('openrouter/openai/gpt-6.1-sol');
  assert.deepEqual([info.known, info.claude, info.variable], [true, false, false]);
  assert.deepEqual([info.price.inputPerM, info.price.outputPerM, info.price.cacheReadPerM, info.price.cacheWritePerM], [2, 10, 0.1, 2.5]);
  assert.equal(pricing.priceInfo('openai/gpt-6.1-sol-pro').price.inputPerM, 2, 'same per-token price; the difference is reasoning tokens spent');
  const small = pricing.estimateCostUsd('openai/gpt-6.1-sol', { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 100_000, cacheWriteTokens: 0 });
  assert.ok(Math.abs(small - (0.2 + 0.1 + 0.01)) < 1e-9);
  const big = pricing.estimateCostUsd('openai/gpt-6.1-sol', { inputTokens: 200_000, outputTokens: 10_000, cacheReadTokens: 100_000, cacheWriteTokens: 0 });
  assert.ok(Math.abs(big - (0.4 * 2 + 0.1 * 1.5 + 0.01 * 2)) < 1e-9, 'past the line: 2× input and cache, 1.5× output');
  // Not confused with the GPT-5 family row.
  assert.notEqual(pricing.priceInfo('openai/gpt-6.1-sol').price.inputPerM, pricing.priceInfo('gpt-5').price.inputPerM);
});

// --- exact cost through the ledger and payroll -------------------------------------

test('a CostSample carrying the provider charge is stored as exact; without it the table estimates', () => {
  const exact = costSampleRow('a1', { session_id: 'proxy-x', model: 'openai/gpt-6.1-sol', input: 1000, output: 100, cache_read: 0, cache_creation: 0, usd: 0.0031, reasoning: 40 }, 5);
  assert.deepEqual([exact.usd, exact.usdExact, exact.reasoning, exact.ts], [0.0031, true, 40, 5]);
  const est = costSampleRow('a1', { session_id: 'proxy-x', model: 'openai/gpt-6.1-sol', input: 100_000, output: 0, cache_read: 0, cache_creation: 0 });
  assert.ok(Math.abs(est.usd - 0.2) < 1e-9, 'estimated from the table under the 272k line');
  assert.equal(est.usdExact, undefined);
});

test('payroll keeps an exact row as billed and re-prices the rest, long-context rule included', () => {
  const now = Date.parse('2026-10-06T15:00:00Z');
  const clock = { now, dayStart: Date.parse('2026-10-06T04:00:00Z') };
  const row = (o) => JSON.stringify({ agent_id: 'w', session_id: 'proxy-qw-1', ts: now, input: 0, output: 0, cache_read: 0, cache_creation: 0, model: 'openai/gpt-6.1-sol', usd: 0, ...o });
  const text = [
    row({ input: 100_000, usd: 0.5, usd_exact: true }),             // kept: $0.50, not the table's $0.20
    row({ input: 100_000, usd: 99 }),                               // re-priced: $0.20
    row({ input: 300_000, output: 10_000, usd: 0 }),                // past 272k: 0.6×2 + 0.1×1.5 = 1.35
    JSON.stringify({ agent_id: 'r', session_id: 'proxy-oc-2', ts: now, input: 1_000_000, output: 0, cache_read: 0, cache_creation: 0, model: 'openrouter/deepseek/deepseek-v4.1-flash', usd: 0 })
  ].join('\n');
  const s = foldPayroll(text, clock);
  const w = s.agents.find((a) => a.agentId === 'w');
  assert.ok(Math.abs(w.windows.today.usd - (0.5 + 0.2 + 1.35)) < 1e-9, `got ${w.windows.today.usd}`);
  assert.equal(w.variablePrice, false);
  const r = s.agents.find((a) => a.agentId === 'r');
  assert.equal(r.variablePrice, true, 'a router-dependent estimate is marked as such');
  assert.equal(r.unknownPrice, false);
});

// --- spawn requests + tiers --------------------------------------------------------------

test('a spawn request naming a tier gets that tier\'s engine and model; explicit fields still win', () => {
  const tier = { provider: 'opencode', model: 'openrouter/openai/gpt-6.1-sol', effort: 'high' };
  const l = buildWorkerLaunch({ autoMode: false, tier, defaultCommand: 'claude' });
  assert.equal(l.bin, 'opencode');
  assert.deepEqual(l.args, ['--model', 'openrouter/openai/gpt-6.1-sol']);
  const own = buildWorkerLaunch({ autoMode: false, tier, requestModel: 'openrouter/x/y' });
  assert.deepEqual(own.args, ['--model', 'openrouter/x/y'], 'the request\'s model wins');
  const cmd = buildWorkerLaunch({ autoMode: false, tier, requestCommand: 'claude --verbose' });
  assert.equal(cmd.bin, 'claude');
  assert.ok(!cmd.args.includes('--model'), 'an explicit command on another engine never gets the tier\'s model');
  const prov = buildWorkerLaunch({ autoMode: false, tier, requestProvider: 'gemini' });
  assert.equal(prov.bin, 'gemini');
  assert.ok(!prov.args.includes('--model'));
});

test('the spawn-request handler, protocol and orchestrator prompt all know about tiers', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /tier\?: 'worker' \| 'routine'/, 'SpawnRequest.tier');
  assert.match(idx, /normalizeTierName\(raw\.tier\)/);
  assert.match(idx, /syncTiersFile\(\)/);
  assert.match(idx, /tiers\.json/);
  const hive = read('src/main/hive.ts');
  assert.match(hive, /\\`tier\\` \("worker" or "routine"/, 'the spawn-queue prompt line names the field');
  assert.match(hive, /re-dispatch ONCE as "worker"/, 'retry once on the stronger tier, never on the manager');
  assert.match(hive, /"tier": "worker \| routine/, 'PROTOCOL.md JSON example');
  assert.match(hive, /Pick the tier by the job/);
});

// --- the proxy sidecar ---------------------------------------------------------------------

/** The sidecar as the hive writes it, loaded as a module (no port is bound). */
function shimPath() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-or-shim-'));
  const hive = new HiveManager(() => home, () => true);
  hive.ensureHive();
  const p = path.join(home, 'hive', 'bin', 'hive-proxy.cjs');
  assert.ok(fs.existsSync(p), 'hive-proxy.cjs written by ensureHive');
  return { p, home };
}

function tune(env, body, pathname) {
  const { p, home } = shimPath();
  try {
    const code = `const m = require(${JSON.stringify(p)}); const out = m.tuneRequestBody(Buffer.from(process.argv[1], 'utf8'), process.argv[2]); process.stdout.write(out.toString('utf8'));`;
    const out = execFileSync(process.execPath, ['-e', code, body, pathname], { env: { ...process.env, UPSTREAM_BASE_URL: 'http://127.0.0.1:9/v1', ...env }, encoding: 'utf8' });
    return out;
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('the sidecar adds usage accounting, the tier effort and an output cap only where the CLI left them unset', () => {
  const env = { HIVE_PROXY_FLAVOR: 'openrouter', HIVE_PROXY_REASONING: 'high', HIVE_PROXY_MAX_TOKENS: '32000' };
  const a = JSON.parse(tune(env, JSON.stringify({ model: 'openai/gpt-6.1-sol', messages: [] }), '/v1/chat/completions'));
  assert.deepEqual(a.usage, { include: true });
  assert.deepEqual(a.reasoning, { effort: 'high' });
  assert.equal(a.max_tokens, 32000);
  // The CLI's own choices are kept.
  const b = JSON.parse(tune(env, JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'low', max_completion_tokens: 500, usage: { include: false } }), '/v1/chat/completions'));
  assert.equal(b.reasoning, undefined);
  assert.equal(b.reasoning_effort, 'low');
  assert.equal(b.max_tokens, undefined);
  assert.equal(b.max_completion_tokens, 500);
  assert.deepEqual(b.usage, { include: false });
  // The Responses API spells the cap differently.
  const c = JSON.parse(tune(env, JSON.stringify({ model: 'm', input: 'x' }), '/v1/responses'));
  assert.equal(c.max_output_tokens, 32000);
  assert.deepEqual(c.reasoning, { effort: 'high' });
  // A plain OpenAI-compatible host (Ollama, vLLM) takes the chat shorthand and no usage flag.
  const d = JSON.parse(tune({ HIVE_PROXY_REASONING: 'low' }, JSON.stringify({ model: 'm', messages: [] }), '/v1/chat/completions'));
  assert.equal(d.reasoning_effort, 'low');
  assert.equal(d.usage, undefined);
  assert.equal(d.max_tokens, undefined);
  // Not JSON, or not a model call: bytes pass through untouched.
  assert.equal(tune(env, 'not json', '/v1/chat/completions'), 'not json');
  assert.equal(tune(env, '{"a":1}', '/v1/models'), '{"a":1}');
  // Nothing to add → untouched (no flavor, no tuning).
  assert.equal(tune({}, '{"model":"m"}', '/v1/chat/completions'), '{"model":"m"}');
});

test('ctxSize reads GPT-6.1 Sol against its 272k billing line', () => {
  const { p, home } = shimPath();
  try {
    const code = `const m = require(${JSON.stringify(p)}); process.stdout.write(JSON.stringify([m.ctxSize('openai/gpt-6.1-sol'), m.ctxSize('claude-opus-4-8'), m.ctxSize('whatever')]));`;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...process.env, UPSTREAM_BASE_URL: 'http://127.0.0.1:9' }, encoding: 'utf8' }));
    assert.deepEqual(out, [272000, 200000, 200000]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('end to end: a proxied OpenRouter call reaches upstream with usage accounting and comes back as an exact-cost CostSample', { skip: process.platform === 'win32' }, async (t) => {
  const { p, home } = shimPath();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // Fake upstream: records the body it got, answers like OpenRouter would.
  let seenBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(req.headers['content-length'], String(Buffer.concat(chunks).length), 'content-length matches the rewritten body');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'gen-1', model: 'openai/gpt-6.1-sol',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1200, completion_tokens: 80, cost: 0.0033, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 30 } }
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());

  // Fake hive socket: collects what the sidecar emits.
  const sock = path.join(home, 'hooks.sock');
  const emitted = [];
  const sockServer = net.createServer((c) => { let buf = ''; c.on('data', (d) => { buf += d; }); c.on('end', () => { for (const ln of buf.split('\n')) if (ln.trim()) emitted.push(JSON.parse(ln)); }); });
  await new Promise((r) => sockServer.listen(sock, r));
  t.after(() => sockServer.close());

  const child = spawn(process.execPath, [p], {
    env: {
      ...process.env, HIVE_SOCK: sock, AGENT_ID: 'qwen-1', HIVE_PROXY_SESSION: 'proxy-qwen-1-abc', HIVE_PROXY_API: 'openai',
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
      HIVE_PROXY_FLAVOR: 'openrouter', HIVE_PROXY_REASONING: 'high', HIVE_PROXY_MAX_TOKENS: '32000'
    },
    stdio: ['ignore', 'pipe', 'ignore']
  });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; const ln = buf.split('\n')[0]; if (ln) { try { resolve(JSON.parse(ln).port); } catch (e) { reject(e); } } });
    setTimeout(() => reject(new Error('sidecar did not report a port')), 8000);
  });
  assert.ok(port > 0);

  const body = JSON.stringify({ model: 'openai/gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }] });
  const reply = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-or-TEST' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(reply.choices[0].message.content, 'ok', 'the CLI gets upstream\'s answer unchanged');
  assert.deepEqual(seenBody.usage, { include: true });
  assert.deepEqual(seenBody.reasoning, { effort: 'high' });
  assert.equal(seenBody.max_tokens, 32000);
  assert.equal(seenBody.model, 'openai/gpt-6.1-sol');

  // Emits are fire-and-forget; give the socket a moment.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !emitted.some((e) => e.hook_event_name === 'CostSample')) await new Promise((r) => setTimeout(r, 25));
  const cost = emitted.find((e) => e.hook_event_name === 'CostSample');
  assert.ok(cost, 'CostSample emitted');
  assert.equal(cost.usd, 0.0033, 'OpenRouter\'s own charge rides the sample');
  assert.equal(cost.reasoning, 30);
  assert.deepEqual([cost.input, cost.output, cost.cache_read, cost.cache_creation, cost.model], [1200, 80, 1000, 50, 'openai/gpt-6.1-sol']);
  const status = emitted.find((e) => e.hook_event_name === 'Status');
  assert.equal(status.context_window.context_window_size, 272000);
  assert.doesNotMatch(JSON.stringify(emitted), /sk-or-TEST/, 'the key never reaches the hive socket');
});

// --- wiring ----------------------------------------------------------------------------

test('the OpenRouter key falls back to the environment, and Settings can tell which source it is', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /function backendKey\(backend: string\): string/);
  assert.match(idx, /process\.env\[envName\]/);
  assert.match(idx, /ipcMain\.handle\('providerKey:source'/);
  assert.match(idx, /ipcMain\.handle\('openrouter:probe'/);
  assert.match(idx, /const key = backendKey\(backend\);/, 'spawns use the same lookup');
  const pre = read('src/preload/index.ts');
  assert.match(pre, /providerKeySource:/);
  assert.match(pre, /openRouterProbe:/);
  const ui = read('src/renderer/src/components/AiEnginesSettings.tsx');
  assert.match(ui, /aiEngines\.fromEnv/);
  assert.match(ui, /aiEngines\.testConnection/);
  assert.match(ui, /data-testid="openrouter-probe"/);
  assert.match(ui, /data-testid="model-tiers"/);
  assert.match(ui, /SUGGESTED_TIERS/);
});

test('OpenCode and Qwen spawns carry the tier: effort + compaction limit for OpenCode, key + model id for Qwen', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /tierMatching\(cfg\.modelTiers, 'opencode', modelSlug\)/);
  assert.match(idx, /options = \{ reasoning: \{ effort: tier\.effort \} \}/, 'OpenRouter reasoning effort via OpenCode model options');
  assert.match(idx, /entry\.limit = \{ context, output: tier\.maxOutputTokens \}/, 'OpenCode compacts before the 272k price line');
  assert.match(idx, /extra\.OPENAI_API_KEY = key;/, 'Qwen reads the OpenRouter key under the OpenAI name');
  assert.match(idx, /extra\.OPENAI_MODEL = id;/);
  assert.match(idx, /isOpenRouterModel\(slug\) \? OPENROUTER_BASE_URL/, 'an openrouter/ slug implies the OpenRouter base URL');
  assert.match(idx, /proxyTuning: spawnTier/);
  const hive = read('src/main/hive.ts');
  assert.match(hive, /HIVE_PROXY_REASONING: cfg\.effort/);
  assert.match(hive, /HIVE_PROXY_MAX_TOKENS: String\(cfg\.maxOutputTokens\)/);
  assert.match(hive, /HIVE_PROXY_FLAVOR: 'openrouter'/);
});

test('the Hire dialog offers the configured tiers as one-click chips', () => {
  const src = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.match(src, /data-testid=\{`tier-chip-\$\{name\}`\}/);
  assert.match(src, /const applyTier = \(tier: ModelTier\)/);
  assert.match(src, /buildSpawnCommand\(config, tier\.model, tier\.provider\)/);
});

test('payroll explains a large token count: cached re-reads and their share', () => {
  const store = loadTs('src/renderer/src/payroll/store.ts');
  const shared = loadTs('src/shared/payroll.ts');
  const a = { agentId: 'god', model: 'claude-opus-5-5', models: ['claude-opus-5-5'], windows: shared.emptyWindows(), unknownPrice: false, claude: true, lastTs: 1 };
  a.windows.today = { input: 500_000, output: 100_000, cacheRead: 12_400_000, cacheWrite: 0, tokens: 13_000_000, usd: 13.9 };
  const labels = { today: 'today', week: '7d', month: '30d', all: 'all', apiEq: 'API-equivalent', unknown: 'unknown', notMetered: 'nm', noUsageYet: 'none', cached: 'cached re-reads' };
  const line = store.payrollLineFor(a, labels, { model: 'claude-opus-5-5', provider: 'claude' });
  assert.match(line.title, /cached re-reads: 12M \(95%\) today/);
  assert.match(line.title, /API-equivalent/);
});
