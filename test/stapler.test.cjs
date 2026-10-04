'use strict';

// Stapler: meeting transcripts. The pure transforms in shared/stapler.ts, the
// on-disk store in main/stapler.ts, and the wiring that keeps the feature
// behind one flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const S = loadTs('src/shared/stapler.ts');
const { StaplerStore } = loadTs('src/main/stapler.ts');

const meeting = (over = {}) => ({
  id: 'm-20261004-ab12cd',
  title: 'Pricing call',
  description: 'Quarterly pricing review with the sales lead.',
  startedAt: '2026-10-04T10:00:00.000Z',
  endedAt: '2026-10-04T10:30:00.000Z',
  themCaptured: true,
  segments: [
    { id: 's1', who: 'you', t0: 0, t1: 20, text: 'Thanks for joining.' },
    { id: 's2', who: 'them', t0: 5, t1: 25, text: 'Happy to.' },
    { id: 's3', who: 'you', t0: 20, t1: 40, text: 'Let us start with the annual plan.' },
    { id: 's4', who: 'you', t0: 40, t1: 60, text: 'It moves to 150.' }
  ],
  ...over
});

// --- ids ------------------------------------------------------------------

test('a minted meeting id is a safe filename and round-trips the validator', () => {
  const id = S.newMeetingId(new Date('2026-10-04T10:00:00Z'), 'x7q9z!');
  assert.equal(id, 'm-20261004100000-x7q9z');
  assert.equal(S.isMeetingId(id), true);
});

test('the validator rejects anything that could escape the meetings directory', () => {
  for (const bad of ['../etc/passwd', 'm/1', 'M-UPPER', '', 'short', 'a'.repeat(65), 42, null]) {
    assert.equal(S.isMeetingId(bad), false, String(bad));
  }
});

// --- phantoms -------------------------------------------------------------

test('what Whisper says to silence is dropped; what people say is kept', () => {
  for (const ghost of ['Thank you.', 'thank you', ' you ', '.', '[BLANK_AUDIO]', 'Thanks for watching!'.replace('!', '.')]) {
    assert.equal(S.isPhantomTranscript(ghost), true, ghost);
  }
  for (const real of ['Thank you for the numbers, Jim.', 'you said 150', 'We ship Friday.']) {
    assert.equal(S.isPhantomTranscript(real), false, real);
  }
});

// --- ordering + markdown ----------------------------------------------------

test('segments interleave by time, You before Them on a tie', () => {
  const sorted = S.sortSegments([
    { id: 'b', who: 'them', t0: 10, t1: 30, text: 'b' },
    { id: 'a', who: 'you', t0: 10, t1: 30, text: 'a' },
    { id: 'c', who: 'you', t0: 0, t1: 20, text: 'c' }
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ['c', 'a', 'b']);
});

test('the markdown reads as dialogue: consecutive turns by one side merge into a paragraph', () => {
  const md = S.meetingToMarkdown(meeting());
  assert.match(md, /^# Pricing call\n/);
  assert.match(md, /- Sides: You \(microphone\) and Them \(system audio\)/);
  assert.match(md, /## Description\n\nQuarterly pricing review/);
  // s3 and s4 are both You, back to back → one paragraph stamped at s3's start.
  assert.match(md, /\*\*You\*\* _\(00:20\)_\n\nLet us start with the annual plan\. It moves to 150\./);
  assert.match(md, /\*\*Them\*\* _\(00:05\)_\n\nHappy to\./);
  assert.ok(md.endsWith('\n'));
});

test('a one-sided meeting says so and an untitled one takes the date', () => {
  const md = S.meetingToMarkdown(meeting({ title: '', themCaptured: false, description: '' }));
  assert.match(md, /^# Meeting 2026-10-04 /);
  assert.match(md, /- Sides: You \(microphone\) only/);
  assert.doesNotMatch(md, /## Description/);
});

test('fmtClock rolls over to hours', () => {
  assert.equal(S.fmtClock(0), '00:00');
  assert.equal(S.fmtClock(65), '01:05');
  assert.equal(S.fmtClock(3661), '1:01:01');
});

// --- agent message ----------------------------------------------------------

test('the agent gets a pointer to the file, the description and the instruction — not the transcript', () => {
  const msg = S.agentMessageFor(meeting(), '/home/me/hive/stapler/meetings/m.md', 'Draft the follow-up email.');
  assert.match(msg, /Meeting transcript: "Pricing call" — 4 segments, both sides\./);
  assert.match(msg, /Full transcript \(markdown\): \/home\/me\/hive\/stapler\/meetings\/m\.md/);
  assert.match(msg, /About this meeting: Quarterly pricing review/);
  assert.match(msg, /Draft the follow-up email\.$/);
  assert.doesNotMatch(msg, /Thanks for joining/);
});

test('an empty instruction gets a sensible default', () => {
  const msg = S.agentMessageFor(meeting({ description: '' }), '/p.md', '   ');
  assert.match(msg, /summarise the decisions and action items/);
  assert.doesNotMatch(msg, /About this meeting/);
});

// --- vocabulary -------------------------------------------------------------

test('the vocabulary becomes a comma list, split on commas or newlines, capped', () => {
  assert.equal(S.vocabularyPrompt('Anthropic\nKubernetes, ARR\n\n  '), 'Anthropic, Kubernetes, ARR');
  assert.equal(S.vocabularyPrompt(''), undefined);
  assert.equal(S.vocabularyPrompt(undefined), undefined);
  const long = Array.from({ length: 200 }, (_, i) => `term${i}`).join(',');
  const out = S.vocabularyPrompt(long, 60);
  assert.ok(out.length <= 60 && out.startsWith('term0, term1'));
});

// --- normalize --------------------------------------------------------------

test('a damaged file normalizes to a valid meeting rather than crashing the list', () => {
  const m = S.normalizeMeeting({ id: 'm-20261004-ab12cd', segments: [{ who: 'them', text: 'hi' }, null, { who: 'you' }] }, 'fallback-id');
  assert.equal(m.id, 'm-20261004-ab12cd');
  assert.equal(m.themCaptured, false);
  assert.deepEqual(m.segments.map((s) => s.text), ['hi']);
  assert.equal(S.normalizeMeeting('nope', 'm-20261004-ab12cd'), null);
  assert.equal(S.normalizeMeeting({}, 'BAD ID'), null);
});

// --- the store --------------------------------------------------------------

test('save writes json + markdown beside each other; list is newest first; delete removes both', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stapler-'));
  try {
    const store = new StaplerStore(root);
    assert.deepEqual(store.list(), []);
    const older = meeting({ id: 'm-20261001-aaaaaa', startedAt: '2026-10-01T09:00:00.000Z', title: 'Old' });
    const newer = meeting();
    assert.equal(store.save(older).ok, true);
    const res = store.save(newer);
    assert.equal(res.ok, true);
    assert.equal(res.markdownPath, path.join(root, 'stapler', 'meetings', `${newer.id}.md`));
    assert.ok(fs.existsSync(path.join(root, 'stapler', 'meetings', `${newer.id}.json`)));
    assert.match(fs.readFileSync(res.markdownPath, 'utf8'), /^# Pricing call/);
    assert.deepEqual(store.list().map((r) => r.title), ['Pricing call', 'Old']);
    assert.equal(store.list()[0].segmentCount, 4);
    assert.deepEqual(store.get(newer.id).segments, newer.segments);
    assert.equal(store.delete(newer.id).ok, true);
    assert.equal(store.get(newer.id), null);
    assert.ok(!fs.existsSync(res.markdownPath));
    assert.equal(store.delete('../x').ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- wiring -----------------------------------------------------------------

test('transcription and the loopback handler both sit behind staplerEnabled, and the key never leaves main', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /ipcMain\.handle\('stapler:transcribe'[\s\S]*?if \(cfg\.staplerEnabled !== true\) return \{ ok: false/);
  assert.match(main, /setDisplayMediaRequestHandler\([\s\S]*?if \(readConfig\(\)\.staplerEnabled !== true\) \{ callback\(\{\}\); return; \}/);
  assert.match(main, /cfg\.staplerEnabled === true;/, 'the mic permission gate must include Stapler');
  const preload = read('src/preload/index.ts');
  assert.doesNotMatch(preload, /groqApiKey:\s*\(/, 'no preload method hands the key out');
});

test('the global chord is registered only while enabled and dropped on quit', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /const STAPLER_SHORTCUT = 'CommandOrControl\+Shift\+Space'/);
  assert.match(main, /if \(want && !have\)[\s\S]*?globalShortcut\.register\(STAPLER_SHORTCUT/);
  assert.match(main, /else if \(!want && have\)[\s\S]*?globalShortcut\.unregister\(STAPLER_SHORTCUT\)/);
  assert.match(main, /app\.on\('will-quit', \(e\) => \{\s*globalShortcut\.unregisterAll\(\);/);
});

test('the three locales carry the same stapler keys', () => {
  const keys = (code, pick) => Object.keys(pick(JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`)))).sort();
  for (const pick of [(j) => j.stapler, (j) => j.officeSidebar, (j) => j.settings.voice, (j) => j.commandCenter.tabs]) {
    assert.deepEqual(keys('zh-CN', pick), keys('en', pick));
    assert.deepEqual(keys('ar', pick), keys('en', pick));
  }
});
