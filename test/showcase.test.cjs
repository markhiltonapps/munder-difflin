'use strict';

// Showcase: the shelf of deliverables agents make for the human. Addressing
// (the cth-showcase scheme), the listing with seen-state, the serving guard,
// and the wiring that puts it in front of the human and in the agents' briefing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const shared = loadTs('src/shared/showcase.ts');
const main = loadTs('src/main/showcase.ts');

// --- addressing ---------------------------------------------------------------

test('a deliverable is a page, picture, PDF or markdown; anything else is not listed', () => {
  assert.equal(shared.showcaseKind('post.html'), 'page');
  assert.equal(shared.showcaseKind('hero.PNG'), 'image');
  assert.equal(shared.showcaseKind('deck.pdf'), 'pdf');
  assert.equal(shared.showcaseKind('plan.md'), 'markdown');
  assert.equal(shared.showcaseKind('script.js'), null);
  assert.equal(shared.showcaseKind('notes'), null);
});

test('the URL round-trips a Windows path and a POSIX path and keeps the file name readable', () => {
  for (const abs of ['C:\\Users\\markh\\office\\hive\\showcase\\erin\\post one.html', '/home/me/office/hive/showcase/pam/hero.png']) {
    const url = shared.showcaseUrl(abs);
    assert.match(url, /^cth-showcase:\/\/f\/[A-Za-z0-9_-]+\/[^/]+$/);
    assert.equal(shared.pathFromShowcaseUrl(url), abs.replace(/\\/g, '/'));
  }
  assert.equal(shared.decodeAbs(shared.encodeAbs('C:/x y/é')), 'C:/x y/é');
});

test('a relative asset inside a page resolves under the same folder, and never above it', () => {
  const page = shared.showcaseUrl('/office/hive/showcase/erin/post.html');
  const asset = new URL('img/hero.png', page).href;
  assert.equal(shared.pathFromShowcaseUrl(asset), '/office/hive/showcase/erin/img/hero.png');
  const escape = new URL('../../../etc/passwd', page).href;
  // The browser collapses the dots at the host boundary; whatever is left must
  // not leave the folder the token names.
  const got = shared.pathFromShowcaseUrl(escape);
  assert.ok(got === null || got.startsWith('/office/hive/showcase/erin/'), got);
  assert.equal(shared.pathFromShowcaseUrl('cth-showcase://f/' + shared.encodeAbs('/a') + '/..%2F..%2Fetc%2Fpasswd'), null);
  assert.equal(shared.pathFromShowcaseUrl('https://example.com/x'), null);
  assert.equal(shared.pathFromShowcaseUrl('cth-showcase://item/x'), null);
});

// --- serving ------------------------------------------------------------------

test('the protocol serves only deliverable assets that exist', () => {
  const ok = shared.showcaseUrl('/s/erin/post.html');
  assert.deepEqual(main.planServe(ok, () => true), { file: '/s/erin/post.html', mime: 'text/html; charset=utf-8' });
  assert.deepEqual(main.planServe(ok, () => false), { status: 404 });
  assert.deepEqual(main.planServe(shared.showcaseUrl('/s/erin/run.sh'), () => true), { status: 403 });
  assert.deepEqual(main.planServe(shared.showcaseUrl('/s/erin/secrets.env'), () => true), { status: 403 });
  assert.deepEqual(main.planServe('https://x/y.html', () => true), { status: 400 });
});

test('pages are served with a policy that forbids scripts and the network', () => {
  const src = read('src/main/showcase.ts');
  assert.match(src, /script-src 'none'/);
  assert.match(src, /connect-src 'none'/);
  const tab = read('src/renderer/src/components/ShowcaseTab.tsx');
  assert.match(tab, /const SANDBOX = '';/, 'the page iframe sandbox must stay fully locked');
  assert.match(tab, /sandbox=\{SANDBOX\}/);
});

// --- listing + seen state -------------------------------------------------------

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-'));
  fs.mkdirSync(path.join(root, 'erin-1'), { recursive: true });
  fs.mkdirSync(path.join(root, 'pam-2', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'erin-1', 'post.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(root, 'pam-2', 'hero.png'), 'png');
  fs.writeFileSync(path.join(root, 'pam-2', 'assets', 'style.css'), 'b{}');
  fs.writeFileSync(path.join(root, 'notes.md'), '# n');
  fs.writeFileSync(path.join(root, '.hidden.html'), 'x');
  return root;
}

test('the listing finds deliverables by agent folder, newest first, and skips assets and dotfiles', () => {
  const root = tmpRoot();
  const items = main.listDeliverables(root, {});
  assert.deepEqual(items.map((i) => i.rel).sort(), ['erin-1/post.html', 'notes.md', 'pam-2/hero.png']);
  // A picture a page references is folded into the page, not listed twice.
  fs.writeFileSync(path.join(root, 'pam-2', 'post.html'), '<img src="hero.png">');
  assert.deepEqual(main.listDeliverables(root, {}).map((i) => i.rel).sort(), ['erin-1/post.html', 'notes.md', 'pam-2/post.html']);
  const post = items.find((i) => i.rel === 'erin-1/post.html');
  assert.equal(post.agent, 'erin-1');
  assert.equal(post.kind, 'page');
  assert.equal(items.find((i) => i.rel === 'notes.md').agent, null);
  assert.ok(items.every((i) => i.unseen));
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].mtimeMs >= items[i].mtimeMs);
});

test('opening an item marks it seen until the file changes again', () => {
  const root = tmpRoot();
  const store = new main.ShowcaseStore(root);
  assert.equal(store.unseenCount(), 3);
  assert.equal(store.markSeen('erin-1/post.html'), true);
  assert.equal(store.unseenCount(), 2);
  assert.equal(store.list().find((i) => i.rel === 'erin-1/post.html').unseen, false);
  // A regenerated post is new again.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'erin-1', 'post.html'), later, later);
  assert.equal(store.list().find((i) => i.rel === 'erin-1/post.html').unseen, true);
  // The id can never point outside the root.
  assert.equal(store.markSeen('../outside.html'), false);
  assert.equal(store.resolveRel('..'), null);
  assert.equal(store.resolveRel(''), null);
});

// --- wiring -------------------------------------------------------------------

test('the Showcase is a Command Center tab, a sidebar surface with a badge, and a registered scheme', () => {
  const cc = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.match(cc, /\{ key: 'showcase', labelKey: 'commandCenter\.tabs\.showcase'/);
  assert.match(cc, /\{tab === 'showcase' && <ShowcaseTab \/>\}/);
  const sb = read('src/renderer/src/components/OfficeSidebar.tsx');
  assert.match(sb, /\{ key: 'showcase', labelKey: 'officeSidebar\.showcase'/);
  assert.match(sb, /s\.key === 'showcase' \? showcaseUnseen/);
  const idx = read('src/main/index.ts');
  assert.match(idx, /protocol\.registerSchemesAsPrivileged\(\[\s*\{ scheme: SHOWCASE_SCHEME/);
  assert.match(idx, /protocol\.handle\(SHOWCASE_SCHEME, \(req\) => serveShowcase\(req\)\)/);
  assert.match(idx, /ipcMain\.handle\('showcase:list'/);
  // "open outside" only ever hands a deliverable-kind file to the OS.
  assert.match(idx, /ipcMain\.handle\('showcase:open'[\s\S]*?!showcaseKind\(abs\)\) return \{ ok: false/);
});

test('agents are told where deliverables go, in the briefing and in PROTOCOL.md', () => {
  const hive = read('src/main/hive.ts');
  assert.match(hive, /5\. Anything made FOR THE HUMAN TO LOOK AT[\s\S]*?\$\{inRoot\('showcase', meta\.id\)\}/);
  assert.match(hive, /## Handing work to the human \(the Showcase\)/);
  assert.match(hive, /showcase\/<your-id>\//);
});

test('the three locales carry the same Showcase strings', () => {
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  for (const code of ['zh-CN', 'ar']) {
    const l = JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));
    assert.deepEqual(Object.keys(l.showcase).sort(), Object.keys(en.showcase).sort(), code);
    assert.ok(l.officeSidebar.showcase && l.officeSidebar.newWork, code);
    assert.ok(l.commandCenter.tabs.showcase, code);
  }
});

test('the renderer policy lets the scheme carry images, frames and fetches', () => {
  const html = read('src/renderer/index.html');
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const dir = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '');
  for (const name of ['img-src', 'frame-src', 'connect-src']) {
    assert.ok(dir(name).includes('cth-showcase:'), `${name} must allow cth-showcase: — a thumbnail or page is otherwise a broken image`);
  }
});

test('an IDE open-file request matches its workspace whatever separator the path uses', () => {
  const store = read('src/renderer/src/store/store.ts');
  assert.match(store, /const norm = \(p: string\): string => p\.replace\(\/\\\\\/g, '\/'\);/);
  const ide = read('src/renderer/src/ide/IdePanel.tsx');
  assert.match(ide, /const abs = queued\.replace\(\/\\\\\/g, '\/'\);/);
  assert.match(ide, /const rootSlash = root\.replace\(\/\\\\\/g, '\/'\);/);
});

// --- projects, archive, grouping ----------------------------------------------

test('the second folder is the project; archived items keep their place under .archive', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'erin-1', 'neato-glasses'), { recursive: true });
  fs.writeFileSync(path.join(root, 'erin-1', 'neato-glasses', 'launch.html'), '<p>x</p>');
  fs.mkdirSync(path.join(root, '.archive', 'pam-2', 'webinar'), { recursive: true });
  fs.writeFileSync(path.join(root, '.archive', 'pam-2', 'webinar', 'old.png'), 'png');
  const items = main.listDeliverables(root, {});
  const launch = items.find((i) => i.rel === 'erin-1/neato-glasses/launch.html');
  assert.deepEqual([launch.agent, launch.project, launch.archived], ['erin-1', 'neato-glasses', false]);
  const post = items.find((i) => i.rel === 'erin-1/post.html');
  assert.deepEqual([post.agent, post.project], ['erin-1', null], 'straight under the agent = unsorted');
  const old = items.find((i) => i.rel === '.archive/pam-2/webinar/old.png');
  assert.deepEqual([old.agent, old.project, old.archived, old.unseen], ['pam-2', 'webinar', true, false], 'archived is never "new"');
});

test('move files an item under a project, carries a page\'s assets and its seen mark; archive puts it away and back', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'erin-1', 'post.html'), '<img src="hero.png"><link href="css/style.css"><a href="https://x.y/z">z</a>');
  fs.writeFileSync(path.join(root, 'erin-1', 'hero.png'), 'png');
  fs.mkdirSync(path.join(root, 'erin-1', 'css'), { recursive: true });
  fs.writeFileSync(path.join(root, 'erin-1', 'css', 'style.css'), 'b{}');
  const store = new main.ShowcaseStore(root);
  store.markSeen('erin-1/post.html');
  const moved = store.move('erin-1/post.html', 'Neato Glasses');
  assert.deepEqual(moved, { ok: true, rel: 'erin-1/neato-glasses/post.html' });
  assert.ok(fs.existsSync(path.join(root, 'erin-1', 'neato-glasses', 'post.html')));
  assert.ok(fs.existsSync(path.join(root, 'erin-1', 'neato-glasses', 'hero.png')), 'the picture travels');
  assert.ok(fs.existsSync(path.join(root, 'erin-1', 'neato-glasses', 'css', 'style.css')), 'so does the stylesheet');
  assert.ok(!fs.existsSync(path.join(root, 'erin-1', 'hero.png')));
  assert.equal(store.list().find((i) => i.rel === 'erin-1/neato-glasses/post.html').unseen, false, 'seen mark followed the file');
  // Back to unsorted, then away and back.
  assert.deepEqual(store.move('erin-1/neato-glasses/post.html', null), { ok: true, rel: 'erin-1/post.html' });
  const away = store.setArchived('erin-1/post.html', true);
  assert.deepEqual(away, { ok: true, rel: '.archive/erin-1/post.html' });
  assert.ok(fs.existsSync(path.join(root, '.archive', 'erin-1', 'post.html')));
  assert.equal(store.unseenCount(), 2, 'archived items do not count as new');
  assert.deepEqual(store.setArchived('.archive/erin-1/post.html', false), { ok: true, rel: 'erin-1/post.html' });
  // Guards.
  assert.equal(store.move('notes.md', 'x').ok, false, 'a root item has no agent folder');
  assert.equal(store.move('erin-1/post.html', '   ').ok, false, 'a blank project name is refused');
  assert.deepEqual(store.move('erin-1/post.html', '../../etc'), { ok: true, rel: 'erin-1/etc/post.html' }, 'dots and slashes are stripped, never walked');
});

test('page assets are the relative references only', () => {
  assert.deepEqual(main.pageAssets('<img src="a.png"><img src="./b/c.jpg"><link href="s.css"><a href="https://x/y"><div style="background:url(img/bg.png)"><img src="../up.png"><a href="#top">').sort(),
    ['a.png', 'b/c.jpg', 'img/bg.png', 's.css']);
});

test('grouping and search are what the shelf shows', () => {
  const now = Date.parse('2026-10-05T15:00:00');
  const mk = (rel, mtimeMs, kind = 'page') => ({ rel, abs: '/s/' + rel, name: rel.split('/').pop(), kind, agent: rel.split('/')[0], project: rel.split('/').length > 2 ? rel.split('/')[1] : null, mtimeMs, size: 1, unseen: true, archived: false });
  const items = [mk('erin/neato/a.html', now - 1000), mk('pam/neato/b.png', now - 3 * 86_400_000, 'image'), mk('pam/c.html', now - 40 * 86_400_000)];
  const byProject = shared.groupItems(items, 'project', now);
  assert.deepEqual(byProject.map((g) => [g.key, g.items.length]), [['neato', 2], ['', 1]], 'unsorted last');
  assert.deepEqual(shared.groupItems(items, 'employee', now).map((g) => g.key), ['erin', 'pam']);
  assert.deepEqual(shared.groupItems(items, 'date', now).map((g) => g.key), ['today', 'week', 'older']);
  assert.deepEqual(shared.groupItems(items, 'type', now).map((g) => g.key), ['page', 'image']);
  assert.equal(shared.groupItems(items, 'project', now)[0].unseen, 2);
  assert.ok(shared.matchesSearch(items[1], 'NEATO'));
  assert.ok(shared.matchesSearch(items[1], 'pam'));
  assert.ok(!shared.matchesSearch(items[1], 'webinar'));
  assert.equal(shared.slugProject('  Neato Glasses / Launch! '), 'neato-glasses-launch');
  assert.equal(shared.slugProject('///'), null);
});

test('the shelf has group-by, search, done and move wired, and agents are told about project folders', () => {
  const tab = read('src/renderer/src/components/ShowcaseTab.tsx');
  assert.match(tab, /groupItems\(visible, groupBy\)/);
  assert.match(tab, /matchesSearch\(i, query\)/);
  assert.match(tab, /showcase\.setArchived\(/);
  assert.match(tab, /showcase\.moveItem\(/);
  assert.match(tab, /onDrop=\{groupBy === 'project' \? \(e\) => onDropOnGroup\(e, g\.key\)/);
  assert.match(read('src/main/index.ts'), /ipcMain\.handle\('showcase:move'/);
  assert.match(read('src/main/index.ts'), /ipcMain\.handle\('showcase:archive'/);
  const hive = read('src/main/hive.ts');
  assert.match(hive, /showcase\/<your-id>\/<project>\//);
  assert.match(hive, /\$\{inRoot\('showcase', meta\.id\)\}\/<project>\//);
});
