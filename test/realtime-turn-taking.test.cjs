'use strict';

// Realtime voice turn-taking: pace → VAD eagerness, barge-in, the delivery
// gate that holds background context until nobody is talking, and the
// config plumbing the Settings → Voice controls depend on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const {
  turnDetectionFor, normalizePace, DeliveryGate, coalesceFloorDeltas, coalesceCompletions,
  TOOL_FILLERS, pickFiller, MAX_BATCH_CHARS
} = loadTs('src/renderer/src/realtime/turnTaking.ts');

// --- pace + barge-in --------------------------------------------------------

test('pace maps onto semantic-VAD eagerness; unknown falls back to balanced', () => {
  assert.equal(turnDetectionFor('eager', true).eagerness, 'high');
  assert.equal(turnDetectionFor('balanced', true).eagerness, 'medium');
  assert.equal(turnDetectionFor('patient', true).eagerness, 'low');
  assert.equal(turnDetectionFor(undefined, true).eagerness, 'medium');
  assert.equal(turnDetectionFor('turbo', true).eagerness, 'medium');
  assert.equal(normalizePace(null), 'balanced');
});

test('barge-in is on unless explicitly off; the reply is always auto-created', () => {
  assert.equal(turnDetectionFor('balanced', undefined).interruptResponse, true);
  assert.equal(turnDetectionFor('balanced', true).interruptResponse, true);
  assert.equal(turnDetectionFor('balanced', false).interruptResponse, false);
  assert.equal(turnDetectionFor('eager', false).createResponse, true);
  assert.equal(turnDetectionFor('eager', false).type, 'semantic_vad');
});

// --- the delivery gate ------------------------------------------------------

/** A gate on a fake clock so the settle window is deterministic. */
function harness(settleMs = 1000) {
  const silent = [], spoken = [];
  let now = 0, pendingTimer = null;
  const gate = new DeliveryGate({
    injectSilent: (t) => silent.push(t),
    speak: (t) => spoken.push(t),
    settleMs,
    setTimeout: (fn, ms) => { pendingTimer = { fn, at: now + ms }; return pendingTimer; },
    clearTimeout: (h) => { if (pendingTimer === h) pendingTimer = null; }
  });
  const advance = (ms) => {
    now += ms;
    if (pendingTimer && pendingTimer.at <= now) { const t = pendingTimer; pendingTimer = null; t.fn(); }
  };
  return { gate, silent, spoken, advance, timerArmed: () => pendingTimer !== null };
}

test('a floor update while Michael is speaking waits for the line to go quiet', () => {
  const h = harness();
  h.gate.onTransportEvent('response.created');
  h.gate.onTransportEvent('output_audio_buffer.started');
  h.gate.floorDelta('Jim went from idle to working');
  h.advance(5000);
  assert.deepEqual(h.silent, [], 'nothing lands mid-reply');
  h.gate.onTransportEvent('response.done');
  h.advance(5000);
  assert.deepEqual(h.silent, [], 'generation done is not playback done over WebRTC');
  h.gate.onTransportEvent('output_audio_buffer.stopped');
  assert.deepEqual(h.silent, [], 'the settle window has to pass first');
  h.advance(999);
  assert.deepEqual(h.silent, []);
  h.advance(1);
  assert.equal(h.silent.length, 1);
  assert.match(h.silent[0], /^\(Floor update: Jim went from idle to working\./);
});

test('updates that pile up are delivered as ONE batch, completions spoken once', () => {
  const h = harness();
  h.gate.onTransportEvent('input_audio_buffer.speech_started');
  h.gate.floorDelta('Oscar started');
  h.gate.floorDelta('card 12 moved to done');
  h.gate.completion('Jim finished the Slack fix');
  h.gate.completion('Oscar finished the tests');
  assert.equal(h.gate.pending, 4);
  h.gate.onTransportEvent('input_audio_buffer.speech_stopped');
  h.advance(1000);
  assert.equal(h.silent.length, 1);
  assert.match(h.silent[0], /^\(Floor updates \(2\): Oscar started · card 12 moved to done\./);
  assert.equal(h.spoken.length, 1);
  assert.match(h.spoken[0], /2 tasks you dispatched just finished: Jim finished the Slack fix Next: Oscar finished the tests\)/);
  assert.equal(h.gate.pending, 0);
});

test('the user starting to talk inside the settle window re-arms it', () => {
  const h = harness();
  h.gate.floorDelta('x');
  h.advance(600);
  h.gate.onTransportEvent('input_audio_buffer.speech_started');
  h.advance(2000);
  assert.deepEqual(h.silent, [], 'held while the user speaks');
  h.gate.onTransportEvent('input_audio_buffer.speech_stopped');
  h.gate.onTransportEvent('response.created');       // the model answers them
  h.gate.onTransportEvent('output_audio_buffer.started');
  h.advance(3000);
  assert.deepEqual(h.silent, []);
  h.gate.onTransportEvent('response.done');
  h.gate.onTransportEvent('output_audio_buffer.stopped');
  h.advance(1000);
  assert.equal(h.silent.length, 1);
});

test('a tool call and a barge-in both count as busy; a quiet line delivers at once after settle', () => {
  const h = harness();
  h.gate.setToolRunning(true);
  h.gate.completion('done');
  h.advance(5000);
  assert.deepEqual(h.spoken, []);
  h.gate.setToolRunning(false);
  h.advance(1000);
  assert.equal(h.spoken.length, 1);

  const g2 = harness();
  g2.gate.onTransportEvent('output_audio_buffer.started');
  g2.gate.floorDelta('y');
  g2.gate.setAudioPlaying(false); // audio_interrupted — playback truncated
  g2.advance(1000);
  assert.equal(g2.silent.length, 1);
});

test('dispose drops the backlog and silences the gate', () => {
  const h = harness();
  h.gate.floorDelta('a');
  h.gate.dispose();
  h.advance(5000);
  h.gate.floorDelta('b');
  h.advance(5000);
  assert.deepEqual(h.silent, []);
  assert.equal(h.gate.pending, 0);
  assert.equal(h.timerArmed(), false);
});

test('empty input coalesces to nothing; long backlogs are capped', () => {
  assert.equal(coalesceFloorDeltas([]), null);
  assert.equal(coalesceFloorDeltas(['  ', '']), null);
  assert.equal(coalesceCompletions([]), null);
  const big = coalesceFloorDeltas(Array.from({ length: 200 }, (_, i) => `agent ${i} did a thing`));
  assert.ok(big.length < MAX_BATCH_CHARS + 120, `${big.length}`);
  assert.match(big, /…\. Mention these only when relevant/);
});

// --- fillers ------------------------------------------------------------------

test('fillers are short spoken asides and pickFiller never runs off the end', () => {
  assert.ok(TOOL_FILLERS.length >= 3);
  for (const f of TOOL_FILLERS) assert.ok(f.length <= 40 && !/[\n()]/.test(f), f);
  assert.equal(pickFiller(() => 0), TOOL_FILLERS[0]);
  assert.equal(pickFiller(() => 0.999999), TOOL_FILLERS[TOOL_FILLERS.length - 1]);
  assert.equal(pickFiller(() => 1), TOOL_FILLERS[TOOL_FILLERS.length - 1]);
});

test('a tool result waits for the filler clip, and the clip is skipped once the model has spoken', async () => {
  const { withSpokenFiller } = loadTs('src/renderer/src/realtime/filler.ts');
  // No clips are cached in a test, so playFiller resolves at once; what we can
  // check is that invoke is transparent and the policy is consulted per call.
  let asked = 0;
  const tools = withSpokenFiller(
    [{ type: 'function', name: 't', invoke: async (_ctx, input) => `echo:${input}` }],
    { shouldPlay: () => { asked += 1; return true; }, sinkId: () => null }
  );
  assert.equal(tools[0].name, 't');
  assert.equal(await tools[0].invoke({}, 'hi'), 'echo:hi');
  assert.equal(asked, 1);
});

// --- wiring -------------------------------------------------------------------

test('the session reads pace, barge-in and filler from config and routes context through the gate', () => {
  const src = read('src/renderer/src/realtime/session.ts');
  assert.match(src, /turnDetectionFor\(voiceCfg\.realtimePace, voiceCfg\.realtimeBargeIn\)/);
  assert.match(src, /withSpokenFiller\(\[\.\.\.realtimeReadTools\(\), \.\.\.realtimeActionTools\(\)\]/);
  assert.match(src, /gate\?\.floorDelta\(sanitizeForVoice\(d\.text\)\)/);
  assert.match(src, /gate\?\.completion\(sanitizeForVoice\(c\.summary\)\)/);
  // Nothing bypasses the gate any more.
  assert.doesNotMatch(src, /injectSilent\(`\(Floor update:/);
  assert.doesNotMatch(src, /session\?\.sendMessage\(\s*`\(System notification/);
  // Settings saved mid-call reach the live session.
  assert.match(src, /onConfigChanged\?\.\(\(c\) =>[\s\S]*?updateSessionConfig\(\{[\s\S]*?turnDetectionFor\(c\.realtimePace, c\.realtimeBargeIn\)/);
  assert.match(src, /gate\?\.dispose\(\)/);
});

test('the three settings exist in every config surface with matching defaults', () => {
  const main = read('src/main/config.ts');
  for (const k of ['realtimePace', 'realtimeBargeIn', 'realtimeToolFiller']) {
    assert.match(main, new RegExp(`${k}\\?:`), `${k} in HarnessConfig`);
    assert.match(read('src/renderer/src/store/config.ts'), new RegExp(`${k}\\?:`), `${k} in renderer config`);
    assert.match(read('src/preload/index.ts'), new RegExp(`${k}\\?:`), `${k} in preload`);
    assert.match(read('src/renderer/src/components/SettingsModal.tsx'), new RegExp(`stage\\(\\{ ${k}:`), `${k} staged by Settings`);
  }
  assert.match(main, /realtimePace: 'balanced',\s*realtimeBargeIn: true,\s*realtimeToolFiller: true,/);
  // Voice can flip them itself (soft tier: cosmetic, instantly reversible).
  const policy = read('src/main/realtimeActions.ts');
  assert.match(policy, /realtimePace: \{ tier: 'soft', type: 'string', values: \['eager', 'balanced', 'patient'\] \}/);
  assert.match(policy, /realtimeBargeIn: \{ tier: 'soft', type: 'boolean' \}/);
  assert.match(policy, /realtimeToolFiller: \{ tier: 'soft', type: 'boolean' \}/);
});

test('the filler clip never exposes or logs the OpenAI key and is cached by content', () => {
  const src = read('src/main/realtime.ts');
  assert.match(src, /ipcMain\.handle\('realtime:fillerClip'/);
  assert.match(src, /createHash\('sha1'\)\.update\(`\$\{TTS_MODEL\}\|\$\{phrase\}`\)/);
  assert.doesNotMatch(src, /console\.(log|error)\([^)]*\bkey\b/);
  assert.match(src, /FILLER_MAX_CHARS = 80/);
});
