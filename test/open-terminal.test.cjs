'use strict';

// The agent card's "open" button: a system terminal at the agent's folder,
// per platform. It used to run the macOS `open -a Terminal` everywhere and
// failed on Windows with "spawn open ENOENT".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { terminalCandidates, openTerminalAt } = loadTs('src/main/openTerminal.ts');

test('macOS keeps the Terminal.app launcher', () => {
  assert.deepEqual(terminalCandidates('darwin', '/Users/me/work'), [{ cmd: 'open', args: ['-a', 'Terminal', '/Users/me/work'] }]);
});

test('Windows tries Windows Terminal, then a plain console parked in the folder', () => {
  const c = terminalCandidates('win32', 'C:\\Users\\markh\\Neato Ventures');
  assert.equal(c[0].cmd, 'wt.exe');
  assert.deepEqual(c[0].args, ['-d', 'C:\\Users\\markh\\Neato Ventures']);
  assert.equal(c[1].cmd, 'cmd.exe');
  assert.equal(c[1].verbatim, true, 'start needs its quoting passed through');
  assert.match(c[1].args.join(' '), /start "" \/D "C:\\Users\\markh\\Neato Ventures" cmd\.exe/);
  assert.ok(!c.some((x) => x.cmd === 'open'), 'no macOS launcher on Windows');
});

test('Linux walks the common terminals', () => {
  const names = terminalCandidates('linux', '/home/me').map((c) => c.cmd);
  assert.deepEqual(names, ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']);
  assert.ok(!names.includes('open'));
});

test('a missing launcher is skipped, and when none exists the error says so', async () => {
  // This container has none of the Linux terminals, so every candidate is ENOENT.
  const r = await openTerminalAt('/tmp', 'linux');
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOENT|no terminal found/);
});

test('the IPC handler delegates to the platform-aware opener', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(main, /ipcMain\.handle\('terminal:openAtFolder'[\s\S]*?return openTerminalAt\(cwd\)/);
  assert.doesNotMatch(main, /spawn\('open', \['-a', 'Terminal'/);
});
