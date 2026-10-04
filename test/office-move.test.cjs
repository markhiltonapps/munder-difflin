'use strict';

// Moving the office between computers: the path rewriting rules, and a real
// export → import round trip through a temp directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/shared/officeMove.ts');
const { exportOffice, inspectArchive, importOffice, rewritePaths } = loadTs('src/main/officeMove.ts');

const WIN = 'C:\\Users\\mark\\work\\api';

// --- roots + guesses -----------------------------------------------------

test('roots are the distinct parents of the agents\' folders, longest first', () => {
  const roots = M.pathRootsOf([WIN, 'C:\\Users\\mark\\work\\web', 'D:\\clients\\acme\\site', 'relative\\path', '', null]);
  assert.deepEqual(roots, ['C:\\Users\\mark\\work', 'D:\\clients\\acme']);
});

test('a user home is recognised on every platform', () => {
  assert.equal(M.userHomeOf(WIN), 'C:\\Users\\mark');
  assert.equal(M.userHomeOf('/Users/mark/work/api'), '/Users/mark');
  assert.equal(M.userHomeOf('/home/mark/work'), '/home/mark');
  assert.equal(M.userHomeOf('D:\\clients'), null);
});

test('the guess re-roots the tail under the new user home in the new style', () => {
  assert.equal(M.guessTarget('C:\\Users\\mark\\work', 'C:\\Users\\mark', '/Users/mark', 'darwin'), '/Users/mark/work');
  assert.equal(M.guessTarget('D:\\clients\\acme', 'C:\\Users\\mark', '/Users/mark', 'darwin'), '/Users/mark/clients/acme');
  assert.equal(M.guessTarget('/Users/mark/work', '/Users/mark', 'C:\\Users\\mark', 'win32'), 'C:\\Users\\mark\\work');
  assert.equal(M.guessTarget('C:\\Users\\mark', 'C:\\Users\\mark', '/Users/mark', 'darwin'), '/Users/mark');
});

// --- remapping --------------------------------------------------------------

const mapping = [{ from: 'C:\\Users\\mark\\work', to: '/Users/mark/work' }, { from: 'C:\\Users\\mark\\munder', to: '/Users/mark/munder' }];

test('a path under a root is rewritten with the target separators; others are untouched', () => {
  assert.equal(M.remapPath(WIN, mapping, 'darwin'), '/Users/mark/work/api');
  assert.equal(M.remapPath('c:\\users\\MARK\\work\\api\\src', mapping, 'darwin'), '/Users/mark/work/api/src');
  assert.equal(M.remapPath('C:\\Users\\mark\\workshop\\x', mapping, 'darwin'), 'C:\\Users\\mark\\workshop\\x');
  assert.equal(M.remapPath('/already/posix', mapping, 'darwin'), '/already/posix');
  assert.equal(M.remapPath('C:\\Users\\mark\\work', mapping, 'darwin'), '/Users/mark/work');
});

test('posix roots are case-sensitive and win32 targets get backslashes', () => {
  const m = [{ from: '/Users/mark/work', to: 'C:\\Users\\mark\\work' }];
  assert.equal(M.remapPath('/Users/mark/work/api/src', m, 'win32'), 'C:\\Users\\mark\\work\\api\\src');
  assert.equal(M.remapPath('/users/mark/work/api', m, 'win32'), '/users/mark/work/api');
});

test('JSON is walked and only string values that are mapped paths change', () => {
  const doc = { agents: [{ id: 'dwight', cwd: WIN, note: 'owns the auth', nested: { worktreePath: 'C:\\Users\\mark\\munder\\worktrees\\dwight' } }], count: 2, flag: true };
  const out = M.remapJson(doc, mapping, 'darwin');
  assert.equal(out.agents[0].cwd, '/Users/mark/work/api');
  assert.equal(out.agents[0].nested.worktreePath, '/Users/mark/munder/worktrees/dwight');
  assert.equal(out.agents[0].note, 'owns the auth');
  assert.equal(out.count, 2);
  assert.equal(out.flag, true);
  // The input is not mutated.
  assert.equal(doc.agents[0].cwd, WIN);
});

test('prose gets its paths rewritten up to the next whitespace or quote', () => {
  const md = 'Repo lives at C:\\Users\\mark\\work\\api\\src (see "C:\\Users\\mark\\work\\api\\README.md"). Not C:\\Users\\mark\\workshop.';
  assert.equal(
    M.remapText(md, mapping, 'darwin'),
    'Repo lives at /Users/mark/work/api/src (see "/Users/mark/work/api/README.md"). Not C:\\Users\\mark\\workshop.'
  );
});

test('the archive name is sortable and unique to the minute', () => {
  assert.equal(M.defaultArchiveName(new Date('2026-10-04T21:07:00Z')), 'munder-difflin-office-20261004-2107.tar.gz');
});

// --- round trip ---------------------------------------------------------------

function seedHome(home) {
  fs.mkdirSync(path.join(home, 'hive', 'agents', 'dwight', 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(home, 'worktrees', 'dwight'), { recursive: true });
  fs.mkdirSync(path.join(home, 'stapler', 'meetings'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', 'registry.json'), JSON.stringify({ agents: [
    { id: 'god', name: 'Michael', cwd: 'C:\\Users\\mark\\munder', isGod: true },
    { id: 'dwight', name: 'Dwight', cwd: WIN, worktreePath: 'C:\\Users\\mark\\munder\\worktrees\\dwight' }
  ] }));
  fs.writeFileSync(path.join(home, 'hive', 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', title: 'Auth' }] }));
  fs.writeFileSync(path.join(home, 'hive', 'agents', 'dwight', 'memory.md'), '# Dwight\n\n- The API checkout is at C:\\Users\\mark\\work\\api\\src.\n');
  fs.writeFileSync(path.join(home, 'roster.json'), JSON.stringify({ version: 1, agents: [{ id: 'dwight', cwd: WIN, note: 'owns the auth' }], selectedId: 'dwight' }));
  fs.writeFileSync(path.join(home, 'stapler', 'meetings', 'm-1.json'), JSON.stringify({ id: 'm-1', title: 'Pricing' }));
  fs.writeFileSync(path.join(home, 'worktrees', 'dwight', 'junk.txt'), 'never travels');
}

test('export → inspect → import moves the office and rewrites every path', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-move-'));
  try {
    const oldHome = path.join(base, 'old');
    const newHome = path.join(base, 'new');
    seedHome(oldHome);
    const archive = path.join(base, 'office.tar.gz');
    const config = { harnessHome: 'C:\\Users\\mark\\munder', groqApiKey: 'gsk_test', autoMode: false, realtimeVoiceEnabled: true };

    const exp = await exportOffice({
      home: oldHome, config, dest: archive, appVersion: '0.4.6', platform: 'win32',
      userHome: 'C:\\Users\\mark', secretsToReenter: ['Slack bot token']
    });
    assert.equal(exp.ok, true, exp.error);
    assert.ok(fs.existsSync(archive));
    assert.ok(!fs.existsSync(path.join(oldHome, '.office-move')), 'the metadata folder is cleaned up');
    assert.deepEqual(exp.manifest.included, ['hive', 'roster.json', 'stapler']);
    assert.equal(exp.manifest.agentCount, 2);
    assert.deepEqual([...exp.manifest.roots].sort(), ['C:\\Users\\mark\\munder\\worktrees', 'C:\\Users\\mark\\work', 'C:\\Users\\mark', path.dirname(oldHome)].sort());

    const ins = await inspectArchive(archive);
    assert.equal(ins.ok, true, ins.error);
    assert.equal(ins.manifest.platform, 'win32');
    assert.deepEqual(ins.manifest.secretsToReenter, ['Slack bot token']);

    const imp = await importOffice({
      archive, newHome, target: 'darwin',
      mapping: [{ from: 'C:\\Users\\mark\\work', to: '/Users/mark/work' }, { from: 'C:\\Users\\mark\\munder', to: newHome }]
    });
    assert.equal(imp.ok, true, imp.error);
    assert.ok(fs.existsSync(path.join(newHome, 'hive', 'tasks.json')));
    assert.ok(fs.existsSync(path.join(newHome, 'stapler', 'meetings', 'm-1.json')));
    assert.ok(!fs.existsSync(path.join(newHome, 'worktrees')), 'worktrees never travel');
    assert.ok(!fs.existsSync(path.join(newHome, '.office-move')), 'no metadata lands in the new home');
    const reg = JSON.parse(fs.readFileSync(path.join(newHome, 'hive', 'registry.json'), 'utf8'));
    assert.equal(reg.agents[1].cwd, '/Users/mark/work/api');
    assert.equal(reg.agents[1].worktreePath, `${newHome}/worktrees/dwight`);
    assert.equal(reg.agents[0].cwd, newHome);
    const roster = JSON.parse(fs.readFileSync(path.join(newHome, 'roster.json'), 'utf8'));
    assert.equal(roster.agents[0].cwd, '/Users/mark/work/api');
    assert.equal(roster.agents[0].note, 'owns the auth');
    assert.match(fs.readFileSync(path.join(newHome, 'hive', 'agents', 'dwight', 'memory.md'), 'utf8'), /\/Users\/mark\/work\/api\/src\./);
    assert.equal(imp.config.harnessHome, newHome);
    assert.equal(imp.config.groqApiKey, 'gsk_test');
    assert.ok(imp.rewrittenFiles >= 3);
    assert.deepEqual(imp.warnings, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an archive without a manifest is refused before anything is unpacked', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-move-'));
  try {
    const bogus = path.join(base, 'bogus.tar.gz');
    const tar = require('tar');
    fs.writeFileSync(path.join(base, 'file.txt'), 'x');
    await tar.create({ gzip: true, file: bogus, cwd: base }, ['file.txt']);
    const ins = await inspectArchive(bogus);
    assert.equal(ins.ok, false);
    assert.match(ins.error, /not an office export/);
    const imp = await importOffice({ archive: bogus, newHome: path.join(base, 'new'), mapping: [], target: 'linux' });
    assert.equal(imp.ok, false);
    assert.ok(!fs.existsSync(path.join(base, 'new')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('rewritePaths leaves non-text and oversized files alone and reports them', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-move-'));
  try {
    fs.mkdirSync(path.join(base, 'hive'), { recursive: true });
    fs.writeFileSync(path.join(base, 'hive', 'blob.bin'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(base, 'hive', 'a.json'), JSON.stringify({ cwd: WIN }));
    const r = rewritePaths(base, [{ from: 'C:\\Users\\mark\\work', to: '/w' }], 'linux', ['hive']);
    assert.equal(r.files, 1);
    assert.deepEqual(r.warnings, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'hive', 'a.json'), 'utf8')).cwd, '/w/api');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the export and import handlers exist, and import quiesces the hive and relaunches', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(main, /ipcMain\.handle\('office:export'/);
  assert.match(main, /ipcMain\.handle\('office:inspect'/);
  assert.match(main, /ipcMain\.handle\('office:import'[\s\S]*?ptyManager\.killAll\(\)[\s\S]*?app\.relaunch\(\)/);
  // A failed import must bring the services back rather than leave the app dead.
  assert.match(main, /if \(!out\.ok\) \{\s*\/\/[^\n]*\n\s*bootstrapHiveServices\(\);/);
});
