'use strict';

// Engine meter: OpenCode (SQLite rows) and Gemini CLI (chat logs) usage into
// the cost ledger, once each, attributed to the right agent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const m = loadTs('src/main/engineMeter.ts');

// --- OpenCode ---------------------------------------------------------------------

const ocRow = (id, data, extra = {}) => ({ id, session_id: 'ses_1', time_updated: 1000, data: JSON.stringify(data), ...extra });

test('OpenCode assistant messages are counted once they complete, with reasoning as output and the model as provider/model', () => {
  const seen = new Set();
  const rows = [
    ocRow('msg_user', { role: 'user' }),
    ocRow('msg_live', { role: 'assistant', tokens: { input: 10, output: 5 }, time: { created: 1 } }),           // still streaming
    ocRow('msg_done', { role: 'assistant', modelID: 'deepseek/deepseek-v4-pro-0813', providerID: 'openrouter', cost: 0.0123,
      tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 20 } }, time: { created: 1, completed: 5000 } }, { time_updated: 6000 }),
    ocRow('msg_zero', { role: 'assistant', tokens: { input: 0, output: 0 }, time: { completed: 7000 } }, { time_updated: 7000 })
  ];
  const { samples, cursor } = m.opencodeSamples(rows, 'stanley', seen);
  assert.equal(samples.length, 1);
  const s = samples[0];
  assert.deepEqual([s.agentId, s.sessionId, s.ts, s.input, s.output, s.cacheRead, s.cacheCreation, s.model, s.usd],
    ['stanley', 'proxy-oc-ses_1', 5000, 1000, 250, 300, 20, 'openrouter/deepseek/deepseek-v4-pro-0813', 0.0123]);
  assert.equal(cursor, 7000);
  assert.ok(seen.has('msg_done') && seen.has('msg_zero') && !seen.has('msg_live'), 'a streaming message is retried next pass');
  // Second pass: nothing new.
  assert.equal(m.opencodeSamples(rows, 'stanley', seen).samples.length, 0);
});

// --- Gemini -----------------------------------------------------------------------

const chat = [
  JSON.stringify({ sessionId: 'abc-123', projectHash: 'h', startTime: '2026-10-05T21:32:45.890Z', kind: 'main' }),
  JSON.stringify({ $set: { messages: [{ id: 'u1', timestamp: '2026-10-05T21:32:46.000Z', type: 'user', content: [{ text: 'hi' }] }] } }),
  JSON.stringify({ id: 'g1', timestamp: '2026-10-05T21:32:47.000Z', type: 'gemini', model: 'gemini-2.5-flash', tokens: { input: 1200, output: 80, cached: 1000, thoughts: 20, tool: 0, total: 1300 } }),
  JSON.stringify({ id: 'g1', timestamp: '2026-10-05T21:32:47.000Z', type: 'gemini', model: 'gemini-2.5-flash', tokens: { input: 1200, output: 90, cached: 1000, thoughts: 20, tool: 0, total: 1310 } }), // re-appended: last wins
  JSON.stringify({ id: 'g2', timestamp: '2026-10-05T21:33:00.000Z', type: 'gemini', model: 'gemini-2.5-flash', tokens: { input: 50, output: 10, cached: 0, thoughts: 0, tool: 0, total: 60 } }),
  JSON.stringify({ $rewindTo: 'g1' }),
  JSON.stringify({ id: 'g3', timestamp: '2026-10-05T21:34:00.000Z', type: 'gemini', model: 'gemini-2.5-pro', tokens: { input: 10, output: 5, cached: 0, thoughts: 0, tool: 0, total: 15 } })
].join('\n') + '\n';

test('a Gemini chat log replays: last write per id wins, $set messages count, a rewind drops what followed', () => {
  const c = m.parseGeminiChat(chat);
  assert.equal(c.sessionId, 'abc-123');
  assert.equal(c.startTime, Date.parse('2026-10-05T21:32:45.890Z'));
  assert.deepEqual(c.records.map((r) => r.id), ['u1', 'g1', 'g3'], 'g2 was rewound away');
  assert.equal(c.records[1].tokens.output, 90, 'the re-appended version won');
});

test('Gemini usage splits cached prompt tokens out of input and bills thoughts as output', () => {
  const seen = new Set();
  const samples = m.geminiSamples(m.parseGeminiChat(chat), 'oscar', seen);
  assert.equal(samples.length, 2);
  const g1 = samples[0];
  assert.deepEqual([g1.agentId, g1.sessionId, g1.input, g1.cacheRead, g1.output, g1.model, g1.ts],
    ['oscar', 'proxy-gm-abc-123', 200, 1000, 110, 'google/gemini-2.5-flash', Date.parse('2026-10-05T21:32:47.000Z')]);
  assert.ok(g1.usd > 0, 'priced at the Gemini flash rate');
  assert.equal(m.geminiSamples(m.parseGeminiChat(chat), 'oscar', seen).length, 0, 'counted once');
});

test('a session belongs to the Gemini agent in that folder that was running when it started', () => {
  const agents = [
    { id: 'old', provider: 'gemini', cwd: 'C:\\Users\\markh\\Neato-Ventures', spawnedAt: 1000, archived: false },
    { id: 'new', provider: 'gemini', cwd: 'c:/users/markh/neato-ventures/', spawnedAt: 5000, archived: false },
    { id: 'claude', provider: 'claude', cwd: 'C:\\Users\\markh\\Neato-Ventures', spawnedAt: 10, archived: false },
    { id: 'elsewhere', provider: 'gemini', cwd: 'C:\\other', spawnedAt: 10, archived: false }
  ];
  assert.equal(m.pickGeminiOwner(agents, 'C:/Users/markh/Neato-Ventures', 3000).id, 'old');
  assert.equal(m.pickGeminiOwner(agents, 'C:/Users/markh/Neato-Ventures', 9000).id, 'new');
  assert.equal(m.pickGeminiOwner(agents, 'C:/nowhere', 9000), null);
  assert.ok(m.sameDir('C:\\A\\B\\', 'c:/a/b'));
});

test('the chat files for a folder come from projects.json or a .project_root marker', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemhome-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  fs.mkdirSync(path.join(home, 'tmp', 'proj-a', 'chats'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tmp', 'proj-b', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [cwd]: 'proj-a' } }));
  fs.writeFileSync(path.join(home, 'tmp', 'proj-b', '.project_root'), cwd + path.sep);
  fs.writeFileSync(path.join(home, 'tmp', 'proj-a', 'chats', 'session-2026-10-05T21-32-0f0e0d0c.jsonl'), chat);
  fs.writeFileSync(path.join(home, 'tmp', 'proj-b', 'chats', 'session-2026-10-05T22-00-aaaaaaaa.jsonl'), chat);
  fs.writeFileSync(path.join(home, 'tmp', 'proj-b', 'chats', 'old.json'), '{}');
  const files = m.geminiChatFilesFor(home, cwd).map((f) => path.basename(f)).sort();
  assert.deepEqual(files, ['session-2026-10-05T21-32-0f0e0d0c.jsonl', 'session-2026-10-05T22-00-aaaaaaaa.jsonl']);
  assert.deepEqual(m.geminiChatFilesFor(home, path.join(os.tmpdir(), 'nope')), []);
});

test('the meter runs end to end against a fake database and a Gemini home, writing each row once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemhome-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  fs.mkdirSync(path.join(root, 'agents', 'stanley'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'stanley', 'opencode.db'), 'fake');
  fs.mkdirSync(path.join(home, 'tmp', 'p', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(home, 'tmp', 'p', '.project_root'), cwd);
  fs.writeFileSync(path.join(home, 'tmp', 'p', 'chats', 'session-x-abc12345.jsonl'), chat);
  const rows = [ocRow('msg_done', { role: 'assistant', modelID: 'm', providerID: 'p', tokens: { input: 5, output: 5 }, time: { completed: 5000 } }, { time_updated: 6000 })];
  const appended = [];
  const meter = new m.EngineMeter({
    hiveRoot: () => root,
    agents: () => [
      { id: 'stanley', provider: 'opencode', cwd, spawnedAt: 1, archived: false },
      { id: 'oscar', provider: 'gemini', cwd, spawnedAt: 1, archived: false }
    ],
    append: (s) => appended.push(s),
    openDb: () => ({ prepare: () => ({ all: () => rows }), close() {} }),
    geminiHome: () => home
  });
  meter.tick();
  meter.tick();
  assert.deepEqual(appended.map((s) => s.agentId).sort(), ['oscar', 'oscar', 'stanley'], 'one OpenCode row + two Gemini replies, once each');
  assert.ok(fs.existsSync(path.join(root, 'agents', 'stanley', '.engine-meter.json')));
  assert.ok(fs.existsSync(path.join(root, 'agents', 'oscar', '.engine-meter.json')));
});

// --- wiring -------------------------------------------------------------------------

test('OpenCode agents get their own database, the meter runs on the floor timer, and both engines count as metered', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /if \(provider === 'opencode' && opts\.hive\?\.id && hive\.root\(\)\) \{[\s\S]*?extra\.OPENCODE_DB = dbPath;/);
  assert.match(idx, /setInterval\(\(\) => engineMeter\.tick\(\), 15_000\);/);
  assert.match(idx, /new Database\(p, \{ readonly: true, fileMustExist: true \}\)/);
  const { providerReportsUsage } = loadTs('src/shared/agentProvider.ts');
  assert.equal(providerReportsUsage('opencode'), true);
  assert.equal(providerReportsUsage('gemini'), true);
  assert.equal(providerReportsUsage('codex'), false);
});
