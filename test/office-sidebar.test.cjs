'use strict';

// The office sidebar ('sidebar' layout): the pure rules behind its rows, and
// the wiring that keeps it in step with the surfaces it links to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const {
  asksByAgent, doingByAgent, matchesSidebarQuery, liveLineFor, taskWaitsOnHuman
} = loadTs('src/renderer/src/components/sidebarAsks.ts');

// --- "asked you" ------------------------------------------------------------

const asked = (over = {}) => ({
  id: 't1', status: 'blocked', assignee: 'dwight',
  humanQA: [{ q: 'Which account?', askedAt: '2026-01-01T00:00:00Z' }],
  ...over
});

test('a blocked card with an open question counts as asked', () => {
  assert.equal(taskWaitsOnHuman(asked()), true);
});

test('an answered or dismissed question no longer counts', () => {
  assert.equal(taskWaitsOnHuman(asked({ humanQA: [{ q: 'x', a: 'y' }] })), false);
  assert.equal(taskWaitsOnHuman(asked({ humanQA: [{ q: 'x', dismissedAt: 'now' }] })), false);
});

test('only BLOCKED cards ask — a doing card with a stale question is not waiting', () => {
  assert.equal(taskWaitsOnHuman(asked({ status: 'doing' })), false);
  assert.equal(taskWaitsOnHuman(asked({ status: 'done' })), false);
});

test('the newest entry decides: an older open question under a newer answer is settled', () => {
  const t = asked({ humanQA: [{ q: 'first' }, { q: 'second', a: 'done' }] });
  // Same rule as TasksKanban.openQuestion: scan from the END for an open ask.
  // The first entry is open, so the card still asks.
  assert.equal(taskWaitsOnHuman(t), true);
  const settled = asked({ humanQA: [{ q: 'first', a: 'ok' }, { q: 'second', a: 'done' }] });
  assert.equal(taskWaitsOnHuman(settled), false);
});

test('asks land on the assignee, and an unassigned ask lands on the orchestrator', () => {
  const tasks = [
    asked({ id: 'a', assignee: 'dwight' }),
    asked({ id: 'b', assignee: 'dwight' }),
    asked({ id: 'c', assignee: undefined }),
    asked({ id: 'd', assignee: 'jim', status: 'doing' }),
    null,
    { id: 'e', status: 'todo' }
  ];
  assert.deepEqual(asksByAgent(tasks, 'god'), { dwight: 2, god: 1 });
});

test('the per-row chips and the Inbox count always agree', () => {
  const tasks = [asked({ id: 'a', assignee: 'dwight' }), asked({ id: 'b' , assignee: undefined })];
  const by = asksByAgent(tasks, 'god');
  const total = Object.values(by).reduce((n, c) => n + c, 0);
  assert.equal(total, tasks.filter(taskWaitsOnHuman).length);
});

test('with no orchestrator on the floor an unassigned ask is dropped, not crashed on', () => {
  assert.deepEqual(asksByAgent([asked({ assignee: undefined })], undefined), {});
});

test('doing stickies mirror the floor strip: doing + assignee + id', () => {
  const tasks = [
    { id: 'a', status: 'doing', assignee: 'jim' },
    { id: 'b', status: 'doing', assignee: 'jim' },
    { id: 'c', status: 'todo', assignee: 'jim' },
    { status: 'doing', assignee: 'pam' }
  ];
  assert.deepEqual(doingByAgent(tasks), { jim: ['a', 'b'] });
});

// --- search -----------------------------------------------------------------

const dwight = { name: 'Dwight', project: 'api', description: 'Backend engineer', note: 'owns the auth\nreview Friday' };

test('an empty query matches everyone', () => {
  assert.equal(matchesSidebarQuery(dwight, ''), true);
  assert.equal(matchesSidebarQuery(dwight, '   '), true);
});

test('search reads the name, the project, the job and the NOTE', () => {
  assert.equal(matchesSidebarQuery(dwight, 'dwi'), true);
  assert.equal(matchesSidebarQuery(dwight, 'API'), true);
  assert.equal(matchesSidebarQuery(dwight, 'backend'), true);
  assert.equal(matchesSidebarQuery(dwight, 'friday'), true);
  assert.equal(matchesSidebarQuery(dwight, 'pam'), false);
});

test('every word must land somewhere, not necessarily in the same field', () => {
  assert.equal(matchesSidebarQuery(dwight, 'api dwight'), true);
  assert.equal(matchesSidebarQuery(dwight, 'api pam'), false);
});

test('an agent with no note or job still searches by name', () => {
  assert.equal(matchesSidebarQuery({ name: 'Kevin' }, 'kev'), true);
  assert.equal(matchesSidebarQuery({ name: 'Kevin' }, 'auth'), false);
});

// --- live line --------------------------------------------------------------

test('the live line is the action while working', () => {
  assert.equal(liveLineFor({ status: 'working', action: 'editing auth.ts', recentAssistantText: 'hi', project: 'api' }), 'editing auth.ts');
});

test('idle: the last line the agent said, then the project', () => {
  assert.equal(liveLineFor({ status: 'idle', action: 'stale', recentAssistantText: 'Done.\n\nTests pass.\n', project: 'api' }), 'Tests pass.');
  assert.equal(liveLineFor({ status: 'idle', recentAssistantText: '   ', project: 'api' }), 'api');
  assert.equal(liveLineFor({ status: 'idle' }), '');
});

// --- wiring -----------------------------------------------------------------

test('every surface the rail links to is a real Command Center tab', () => {
  const rail = read('src/renderer/src/components/OfficeSidebar.tsx');
  const cc = read('src/renderer/src/components/CommandCenterPanel.tsx');
  const keys = [...rail.matchAll(/\{ key: '([a-z-]+)',\s+labelKey: 'officeSidebar\./g)].map((m) => m[1]);
  assert.ok(keys.length >= 5, 'the surface list vanished');
  for (const k of keys) {
    assert.match(cc, new RegExp(`\\{ key: '${k}',`), `${k} is not a Command Center tab`);
  }
});

test('the rail opens a surface through the store request, never by owning tab state', () => {
  const rail = read('src/renderer/src/components/OfficeSidebar.tsx');
  assert.match(rail, /requestCommandCenterTab\(key\)/);
  assert.doesNotMatch(rail, /<CommandCenterPanel/);
});

test('the layout preference is persisted and defaults to the classic strip', () => {
  const store = read('src/renderer/src/store/store.ts');
  assert.match(store, /const LS_LAYOUT_MODE = 'cth\.layoutMode'/);
  assert.match(store, /if \(v === 'classic' \|\| v === 'sidebar'\) return v;\s*\} catch \{[^}]*\}\s*return 'classic';/);
});

test('the three locales carry the same officeSidebar keys', () => {
  const keys = (code) => Object.keys(JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`)).officeSidebar).sort();
  assert.deepEqual(keys('zh-CN'), keys('en'));
  assert.deepEqual(keys('ar'), keys('en'));
});
