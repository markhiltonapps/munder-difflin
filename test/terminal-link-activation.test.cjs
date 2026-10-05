'use strict';
/**
 * What a click on a terminal link may do.
 *
 * The provider underlines tokens found in agent output, so the text is hostile
 * by assumption. The rule:
 *   - a URL acts only on ⌘/Ctrl+click, and only through the https-only
 *     main-process opener;
 *   - a PATH may act on a plain click, but only INSIDE the app (the Showcase
 *     viewer or the IDE, both read-only surfaces that run nothing); the OS file
 *     browser is reachable only behind ⌘/Ctrl.
 * Losing the URL gate turns printed agent output into a one-click browser
 * navigation; letting a plain path click reach the OS turns it into a
 * one-click file open. Both are pinned here rather than left to review.
 *
 * `terminalPool.ts` imports xterm and React, so it cannot be require()d here.
 * This reads it as source, the same approach test/arabic-terminal.test.cjs uses
 * for this exact file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/renderer/src/components/terminalPool.ts'), 'utf8');

/** The body of the link provider, where every activate() lives. */
function providerBody() {
  const i = src.indexOf('function registerMarkdownLinkProvider');
  assert.ok(i > 0, 'the link provider has been renamed — this test needs updating');
  const rest = src.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n'));
}

function activatePathBody() {
  const i = src.indexOf('async function activatePath');
  assert.ok(i > 0, 'activatePath has been renamed — this test needs updating');
  const rest = src.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n'));
}

test('the URL activate() is gated on a Cmd/Ctrl modifier', () => {
  const body = providerBody();
  const url = body.indexOf("span.kind === 'url'");
  assert.ok(url > 0, "the url branch has moved — this test needs updating");
  const branch = body.slice(url, body.indexOf('continue;', url));
  assert.match(branch, /if \(event && !\(event\.metaKey \|\| event\.ctrlKey\)\) return;/);
});

test('the URL branch opens only through the guarded opener, and only once', () => {
  // A second openExternal call site would be a way around the gate above.
  assert.equal(src.split('openExternal').length - 1, 1,
    'openExternal appears more than once in terminalPool.ts');
  const body = providerBody();
  const call = body.indexOf('openExternal');
  const gate = body.lastIndexOf('metaKey', call);
  assert.ok(gate > 0 && call - gate < 400,
    'the openExternal call is not behind a modifier gate');
});

test('the URL branch never reaches the filesystem verdicts', () => {
  // A URL is not a path: it must not reach statAbs, revealPath or the IDE.
  const body = providerBody();
  const url = body.indexOf("span.kind === 'url'");
  const branch = body.slice(url, body.indexOf('continue;', url));
  for (const forbidden of ['statAbs', 'revealPath', 'openFileInIde', 'activatePath']) {
    assert.ok(!branch.includes(forbidden), `the url branch reaches ${forbidden}`);
  }
});

test('a plain click on a path stays inside the app; the OS file browser needs the modifier', () => {
  const body = providerBody();
  // The path branch computes `reveal` from the modifier and hands it on.
  assert.match(body, /const reveal = !!event && \(event\.metaKey \|\| event\.ctrlKey\);/);
  assert.match(body, /activatePath\(candidates, action, reveal\)/);
  // Inside activatePath, revealPath is reachable only on `reveal` (or for a
  // directory, which no in-app surface can show), never via a plain click.
  const ap = activatePathBody();
  assert.equal(ap.split('revealPath').length - 1, 1, 'revealPath appears more than once in activatePath');
  assert.match(ap, /if \(reveal \|\| !hit\.isFile\) \{\s*void window\.cth\.revealPath/);
  // And a plain click never reaches anything that launches or navigates.
  for (const forbidden of ['openExternal', 'openPath', 'shell.']) {
    assert.ok(!ap.includes(forbidden), `activatePath reaches ${forbidden}`);
  }
});

test('relative paths are tried against the agent cwd, then the hive, then the office home', () => {
  const loadTs = require('./load-ts.cjs');
  const { relativePathCandidates } = loadTs('src/shared/terminalPaths.ts');
  assert.match(src, /relativePathCandidates\(p, cwd, home\)/, 'the provider must use the shared candidate order');
  assert.deepEqual(
    relativePathCandidates('./agents/worker-erin-email-1/work/plan.md', 'C:/Users/markh/Neato-Ventures', 'C:/Users/markh/office'),
    [
      'C:/Users/markh/Neato-Ventures/agents/worker-erin-email-1/work/plan.md',
      'C:/Users/markh/office/hive/agents/worker-erin-email-1/work/plan.md',
      'C:/Users/markh/office/agents/worker-erin-email-1/work/plan.md'
    ]
  );
  assert.deepEqual(relativePathCandidates('x.md', null, null), []);
});
