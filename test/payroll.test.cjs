'use strict';

// Payroll: price lookup across engines, the ledger fold into windows with both
// sample styles (cumulative Claude telemetry, per-request proxy rows), the CSV,
// and the wiring that puts it in front of the owner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const pricing = loadTs('src/main/pricing.ts');
const { foldPayroll } = loadTs('src/main/payroll.ts');
const shared = loadTs('src/shared/payroll.ts');

// --- prices -------------------------------------------------------------------

test('Claude families keep their rates; an unknown Claude id falls back to Sonnet and says so', () => {
  assert.equal(pricing.priceInfo('claude-opus-4-8[1m]').price.outputPerM, 75);
  assert.equal(pricing.priceInfo('claude-haiku-4-5-20251001').price.inputPerM, 0.8);
  const unk = pricing.priceInfo('claude-fable-5-1');
  assert.equal(unk.claude, true);
  assert.equal(unk.known, false);
  assert.equal(unk.price.inputPerM, 3);
});

test('cheap engines are priced by family, with routing prefixes stripped; local models are free', () => {
  const ds = pricing.priceInfo('openrouter/deepseek/deepseek-v4-pro-0813');
  assert.deepEqual([ds.known, ds.claude, ds.price.inputPerM, ds.price.outputPerM], [true, false, 0.19, 4.2]);
  assert.equal(pricing.priceInfo('openrouter/deepseek/deepseek-v4.1-flash').price.outputPerM, 2.4);
  assert.equal(pricing.priceInfo('groq/llama-3.3-70b-versatile').price.inputPerM, 0.59);
  assert.equal(pricing.priceInfo('google/gemini-2.5-flash').price.inputPerM, 0.3);
  assert.equal(pricing.priceInfo('flash').price.inputPerM, 0.3, 'the Gemini CLI alias');
  const local = pricing.priceInfo('ollama/qwen3-coder:30b');
  assert.deepEqual([local.known, local.local, local.price.outputPerM], [true, true, 0]);
  const none = pricing.priceInfo('openrouter/someone/brand-new-model');
  assert.deepEqual([none.known, none.claude, none.price.inputPerM], [false, false, 0], 'never Claude rates for a non-Claude unknown');
  // estimateCostUsd follows: zero for an unknown non-Claude model, not Sonnet.
  assert.equal(pricing.estimateCostUsd('openrouter/x/y', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0);
});

test('owner overrides win and are matched by substring', () => {
  pricing.setPriceOverrides('# comment\ndeepseek-v4-pro 1 2\nflash 0 0 0 0\n');
  assert.equal(pricing.priceInfo('openrouter/deepseek/deepseek-v4-pro-0813').price.outputPerM, 2);
  assert.equal(pricing.priceInfo('gemini-2.5-flash').price.inputPerM, 0);
  pricing.setPriceOverrides('');
  assert.equal(pricing.priceInfo('openrouter/deepseek/deepseek-v4-pro-0813').price.outputPerM, 4.2);
  assert.deepEqual(pricing.parsePriceOverrides('bad line\nx 1 notanumber\n'), []);
});

// --- the fold ---------------------------------------------------------------

const H = 3_600_000, D = 86_400_000;
const now = Date.parse('2026-10-05T15:00:00Z');
const clock = { now, dayStart: Date.parse('2026-10-05T04:00:00Z') };
const row = (o) => JSON.stringify({ agent_id: 'a', session_id: 's1', ts: now, input: 0, output: 0, cache_read: 0, cache_creation: 0, model: 'claude-sonnet-4-6', usd: 0, ...o });

test('cumulative Claude rows are differenced, a restart counts as a fresh increment, windows split by time', () => {
  const text = [
    row({ ts: now - 20 * D, input: 1000, output: 100, usd: 0.10 }),   // all only
    row({ ts: now - 20 * D + H, input: 3000, output: 300, usd: 0.30 }), // +2000/+200/+0.20
    row({ ts: now - 3 * D, input: 500, output: 50, usd: 0.05 }),       // restart: counts 500/50/0.05 → week + month
    row({ ts: now - 2 * H, input: 1500, output: 150, usd: 0.15 })      // +1000/+100/+0.10 → today
  ].join('\n');
  const s = foldPayroll(text, clock);
  const a = s.agents[0];
  assert.equal(a.agentId, 'a');
  assert.equal(a.claude, true);
  assert.equal(a.model, 'claude-sonnet-4-6');
  assert.deepEqual([a.windows.all.input, a.windows.all.output], [1000 + 2000 + 500 + 1000, 100 + 200 + 50 + 100]);
  assert.ok(Math.abs(a.windows.all.usd - 0.45) < 1e-9);
  assert.ok(Math.abs(a.windows.month.usd - 0.45) < 1e-9, 'twenty days ago is inside the 30-day window');
  assert.ok(Math.abs(a.windows.week.usd - 0.15) < 1e-9);
  assert.ok(Math.abs(a.windows.today.usd - 0.10) < 1e-9);
  assert.equal(a.windows.today.tokens, 1100);
  assert.equal(s.floor.all.tokens, a.windows.all.tokens);
});

test('proxy rows are per-request increments and are re-priced from tokens at the real model rate', () => {
  const text = [
    row({ agent_id: 'q', session_id: 'proxy-q-abc', model: 'openrouter/deepseek/deepseek-v4-pro-0813', input: 1_000_000, output: 0, usd: 3 }),
    row({ agent_id: 'q', session_id: 'proxy-q-abc', model: 'openrouter/deepseek/deepseek-v4-pro-0813', input: 1_000_000, output: 1_000_000, usd: 3 })
  ].join('\n');
  const s = foldPayroll(text, clock);
  const q = s.agents[0];
  assert.equal(q.windows.today.input, 2_000_000, 'two requests of a million each, not a diff');
  assert.ok(Math.abs(q.windows.today.usd - (0.19 + 0.19 + 4.20)) < 1e-9, 'DeepSeek rates, not the $3 Sonnet placeholder');
  assert.equal(q.claude, false);
  assert.equal(q.unknownPrice, false);
});

test('an unpriced model is counted in tokens, flagged, and listed', () => {
  const text = row({ agent_id: 'z', session_id: 'proxy-z-1', model: 'openrouter/acme/mystery-9', input: 10, output: 10 });
  const s = foldPayroll(text, clock);
  assert.equal(s.agents[0].unknownPrice, true);
  assert.equal(s.agents[0].windows.all.usd, 0);
  assert.deepEqual(s.unknownModels, ['openrouter/acme/mystery-9']);
});

test('garbage lines are skipped and an empty ledger reads as empty', () => {
  const s = foldPayroll('not json\n{"agent_id": 5}\n\n', clock);
  assert.equal(s.empty, true);
  assert.deepEqual(s.agents, []);
});

// --- presentation -----------------------------------------------------------

test('labels and numbers read at a glance', () => {
  assert.equal(shared.shortModelLabel('openrouter/deepseek/deepseek-v4-pro-0813'), 'deepseek-v4-pro');
  assert.equal(shared.shortModelLabel('claude-opus-4-8[1m]'), 'claude-opus-4-8');
  assert.equal(shared.shortModelLabel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(shared.shortModelLabel('flash'), 'flash');
  assert.equal(shared.fmtTokens(1234), '1.2k');
  assert.equal(shared.fmtTokens(2_450_000), '2.5M');
  assert.equal(shared.fmtUsd(0), '$0');
  assert.equal(shared.fmtUsd(0.004), '<$0.01');
  assert.equal(shared.fmtUsd(1.234), '$1.23');
  assert.equal(shared.fmtUsd(42.5), '$42.5');
});

test('the CSV has one row per agent, the four windows side by side, and a floor total', () => {
  const text = row({ ts: now - H, input: 10, output: 5, usd: 0.01 });
  const s = foldPayroll(text, clock);
  const csv = shared.payrollCsv(s, (id) => (id === 'a' ? 'Michael, boss' : id));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^agent,agent_id,model,claude_api_equivalent,price_unknown,today_tokens/);
  assert.match(lines[1], /^"Michael, boss",a,claude-sonnet-4-6,yes,no,15,10,5,0,0,0\.0100/);
  assert.match(lines[2], /^FLOOR TOTAL,/);
});

// --- wiring -------------------------------------------------------------------

test('the Payroll is a Command Center tab, a sidebar surface, an IPC call, and a voice tool', () => {
  const cc = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.match(cc, /\{ key: 'payroll', labelKey: 'commandCenter\.tabs\.payroll'/);
  assert.match(cc, /\{tab === 'payroll' && <PayrollTab \/>\}/);
  assert.match(read('src/renderer/src/components/OfficeSidebar.tsx'), /\{ key: 'payroll',\s+labelKey: 'officeSidebar\.payroll'/);
  assert.match(read('src/main/index.ts'), /ipcMain\.handle\('payroll:summary'/);
  assert.match(read('src/main/index.ts'), /setPriceOverrides\(/);
  assert.match(read('src/renderer/src/realtime/tools.ts'), /name: 'get_payroll'/);
});

test('every agent row carries the cost line in both layouts', () => {
  assert.match(read('src/renderer/src/components/OfficeSidebar.tsx'), /usePayrollLine\(agent\.id,/);
  assert.match(read('src/renderer/src/components/AgentStrip.tsx'), /costLine=\{/);
});

test('the three locales carry the same Payroll strings', () => {
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  for (const code of ['zh-CN', 'ar']) {
    const l = JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));
    assert.deepEqual(Object.keys(l.payroll).sort(), Object.keys(en.payroll).sort(), code);
    assert.ok(l.officeSidebar.payroll && l.commandCenter.tabs.payroll, code);
  }
});

test('the roster engine wins the label, and an engine that reports no usage reads "not metered"', () => {
  const { providerReportsUsage } = loadTs('src/shared/agentProvider.ts');
  assert.equal(providerReportsUsage('claude'), true);
  assert.equal(providerReportsUsage('qwen'), true, 'proxy bridge meters it');
  assert.equal(providerReportsUsage('crush'), true);
  for (const p of ['gemini', 'opencode', 'pi', 'codex']) assert.equal(providerReportsUsage(p), false, p);
  assert.equal(providerReportsUsage(undefined), true, 'legacy records are Claude');
  const store = read('src/renderer/src/payroll/store.ts');
  assert.match(store, /const label = shortModelLabel\(configured\.model \|\| a\?\.model \|\| null\);/);
  assert.match(store, /if \(!metered\) \{\s*return \{ line: `\$\{label\} · \$\{labels\.notMetered\}`/);
  assert.match(read('src/renderer/src/components/OfficeSidebar.tsx'), /\{ model: agent\.model, provider: agent\.provider \}/);
  assert.match(read('src/renderer/src/components/AgentStrip.tsx'), /\{ model: a\.model, provider: a\.provider \}/);
  for (const code of ['en', 'zh-CN', 'ar']) {
    const l = JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));
    for (const k of ['notMetered', 'notMeteredTag', 'noUsageYet']) assert.ok(l.payroll[k], `${code}.payroll.${k}`);
  }
});
