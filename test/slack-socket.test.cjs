'use strict';

// Slack Socket Mode: the frame protocol (pure), the shared event router both
// transports feed, and the wiring that makes the transport a config choice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { planFrame } = loadTs('src/main/slackSocket.ts');
const { SlackEventRouter } = loadTs('src/main/slack.ts');

// --- frames -----------------------------------------------------------------

test('hello marks the link up and needs no ack', () => {
  assert.deepEqual(planFrame({ type: 'hello', num_connections: 1 }), { hello: true });
});

test('an events_api envelope is acked AND routed', () => {
  const payload = { type: 'event_callback', event: { type: 'app_mention', text: '<@U1> hi', channel: 'C1', ts: '1.1' } };
  const plan = planFrame({ type: 'events_api', envelope_id: 'env-1', payload, accepts_response_payload: false });
  assert.equal(plan.ack, 'env-1');
  assert.deepEqual(plan.event, payload);
  assert.equal(plan.reconnect, undefined);
});

test('envelope kinds we do not handle are still acked, never routed', () => {
  for (const type of ['slash_commands', 'interactive', 'something_new']) {
    const plan = planFrame({ type, envelope_id: 'env-2', payload: { command: '/x' } });
    assert.equal(plan.ack, 'env-2', type);
    assert.equal(plan.event, undefined, type);
  }
});

test('disconnect asks for a reconnect and is not acked', () => {
  assert.deepEqual(planFrame({ type: 'disconnect', reason: 'refresh_requested' }), { reconnect: true });
});

test('garbage in, nothing out', () => {
  assert.deepEqual(planFrame(null), {});
  assert.deepEqual(planFrame({}), {});
  assert.deepEqual(planFrame({ type: 'events_api' }), {});
});

// --- the router both transports share ---------------------------------------

const mention = (over = {}) => ({
  type: 'event_callback',
  authorizations: [{ user_id: 'UBOT' }],
  event: { type: 'message', text: '<@UBOT> ship it', channel: 'C1', ts: '100.1', user: 'UME', ...over }
});

test('an @-mention reaches onMessage with the mention stripped and the thread set', () => {
  const got = [];
  const r = new SlackEventRouter({ onMessage: (m) => { got.push(m); } });
  assert.equal(r.handleEventCallback(mention()), true);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'ship it');
  assert.equal(got[0].channel, 'C1');
  assert.equal(got[0].thread_ts, '100.1');
});

test('the same message delivered twice (app_mention + message.*) is handed on once', () => {
  const got = [];
  const r = new SlackEventRouter({ onMessage: (m) => { got.push(m); } });
  r.handleEventCallback(mention());
  r.handleEventCallback(mention({ type: 'app_mention' }));
  assert.equal(got.length, 1);
});

test('a plain channel message that mentions nobody is ignored', () => {
  const got = [];
  const r = new SlackEventRouter({ onMessage: (m) => { got.push(m); } });
  assert.equal(r.handleEventCallback(mention({ text: 'just chatting' })), false);
  assert.equal(got.length, 0);
});

test('non-event payloads are ignored', () => {
  const r = new SlackEventRouter({ onMessage: () => {} });
  assert.equal(r.handleEventCallback({ type: 'url_verification', challenge: 'x' }), false);
  assert.equal(r.handleEventCallback({}), false);
});

// --- wiring -----------------------------------------------------------------

test('the transport is a config choice and both go through one inbound handler', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /if \(cfg\.slackMode === 'socket'\) \{[\s\S]*?new SlackSocketClient\(/);
  assert.match(main, /router: new SlackEventRouter\(\{ channelId: cfg\.slackChannelId, onMessage: onSlackInbound \}\)/);
  assert.match(main, /onMessage: onSlackInbound\s*\}\);\s*res = await slackServer\.start\(\)/);
  // Stop tears down whichever is live; status reports the mode.
  assert.match(main, /slackSocket\?\.stop\(\)/);
  assert.match(main, /mode: readConfig\(\)\.slackMode === 'socket'/);
  // Boot and recovery both use the mode-aware gate, never the signing-secret-only one.
  assert.doesNotMatch(main, /slackEnabled && \w+\.slackSigningSecret/);
});

test('the app-level token is used only for the Authorization header', () => {
  const src = read('src/main/slackSocket.ts');
  assert.match(src, /Authorization: `Bearer \$\{appToken\}`/);
  assert.doesNotMatch(src, /console\.(log|error)\([^)]*appToken/);
});

test('every envelope is acked before it is routed', () => {
  const src = read('src/main/slackSocket.ts');
  const ack = src.indexOf("JSON.stringify({ envelope_id: plan.ack })");
  const route = src.indexOf('this.opts.router.handleEventCallback(plan.event)');
  assert.ok(ack > 0 && route > ack, 'ack must come first: Slack redelivers after three seconds');
});

test('the three locales carry the same Socket Mode strings', () => {
  const keys = (code) => Object.keys(JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`)).settings.connections).sort();
  assert.deepEqual(keys('zh-CN'), keys('en'));
  assert.deepEqual(keys('ar'), keys('en'));
  assert.ok(keys('en').includes('appToken'));
});
