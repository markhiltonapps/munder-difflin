'use strict';
/**
 * Startup smoke: boot the REAL main process under Electron and check a window
 * comes up.
 *
 *   npm run build && npx electron tools/smoke-startup.cjs
 *
 * Exit 0 = at least one BrowserWindow exists after SMOKE_WAIT_MS (default 15s);
 * exit 3 = none did. That second case is what a throw during main's module
 * evaluation looks like from the outside: the keep-alive uncaughtException
 * handler swallows it, the process stays up, and the code that opens the
 * window never runs — the app "launches" to nothing. Typecheck, bundling and
 * renderer screenshots all pass through that; only booting main catches it.
 *
 * Env:
 *   SMOKE_MAIN          main bundle to boot (default out/main/index.js)
 *   SMOKE_WAIT_MS       how long to wait before counting windows
 *   SMOKE_STUB_NATIVE=1 replace better-sqlite3 and node-pty with inert
 *                       stand-ins — for a machine where they cannot be rebuilt
 *                       for Electron's ABI (neither is on the startup path).
 *   HOME / XDG_CONFIG_HOME  point at a throwaway dir to boot as a first run.
 * On Linux without a display: `xvfb-run -a npx electron tools/smoke-startup.cjs`.
 */
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

if (process.env.SMOKE_STUB_NATIVE === '1') {
  const Module = require('module');
  class FakeDb {
    pragma(sql, opts) { return opts && opts.simple ? 0 : []; }
    exec() {}
    transaction(fn) { return (...a) => fn(...a); }
    prepare() { return { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }; }
    close() {}
  }
  const fakePty = { spawn: () => ({ pid: 1, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {}, pause() {}, resume() {} }) };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'better-sqlite3') return FakeDb;
    if (request === 'node-pty') return fakePty;
    return origLoad.call(this, request, parent, isMain);
  };
}

const seen = [];
process.on('uncaughtException', (e) => { seen.push(String((e && e.stack) || e)); });

app.whenReady().then(() => {
  setTimeout(() => {
    const wins = BrowserWindow.getAllWindows();
    console.log(`[smoke] windows=${wins.length} ${wins.map((w) => JSON.stringify(w.getTitle())).join(' ')}`);
    if (seen.length) console.log(`[smoke] uncaught: ${seen.join(' | ').slice(0, 600)}`);
    app.exit(wins.length > 0 ? 0 : 3);
  }, Number(process.env.SMOKE_WAIT_MS || 15000));
});

require(process.env.SMOKE_MAIN || path.join(__dirname, '..', 'out', 'main', 'index.js'));
