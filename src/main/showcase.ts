/**
 * Showcase — main-process side. See src/shared/showcase.ts for the idea.
 *
 * The store lists the files under `<hive>/showcase`, remembers which ones the
 * human has opened (a small state file beside them, keyed by path and mtime so
 * a re-generated post counts as new again), and watches the folder so the
 * renderer learns about a new deliverable the moment it is written.
 *
 * The protocol handler serves files to the renderer. It never serves anything
 * outside the folder a URL names, and only file types a deliverable is made
 * of, so a page cannot reach across the disk even by naming a path.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { createReadStream } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { ARCHIVE_DIR, MIME_BY_EXT, SERVABLE_EXTS, extOf, pathFromShowcaseUrl, showcaseKind, slugProject, type ShowcaseItem } from '../shared/showcase';

const STATE_FILE = '.showcase-state.json';
const MAX_DEPTH = 4;
const MAX_ITEMS = 500;

interface SeenState { seen: Record<string, number> }

function readState(root: string): SeenState {
  try {
    const raw = JSON.parse(readFileSync(join(root, STATE_FILE), 'utf8')) as Partial<SeenState>;
    return { seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {} };
  } catch {
    return { seen: {} };
  }
}

/** `<agent>/<project>/<name>` → the agent and project folders of an item path
 *  (relative to the live tree or to .archive/). */
export function placeOf(liveRel: string): { agent: string | null; project: string | null } {
  const parts = liveRel.split('/');
  if (parts.length < 2) return { agent: null, project: null };
  return { agent: parts[0], project: parts.length >= 3 ? parts[1] : null };
}

/** Pure listing over a directory tree, exported for the tests. The live tree
 *  and `.archive/` are both read; an archived item's rel keeps the `.archive/`
 *  prefix so it stays a unique, stable id. */
export function listDeliverables(root: string, seen: Record<string, number>): ShowcaseItem[] {
  const out: ShowcaseItem[] = [];
  const walk = (dir: string, depth: number, archived: boolean): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_ITEMS) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1, archived); continue; }
      if (!e.isFile()) continue;
      const kind = showcaseKind(e.name);
      if (!kind) continue;
      let st: ReturnType<typeof statSync>;
      try { st = statSync(abs); } catch { continue; }
      const rel = relative(root, abs).split(sep).join('/');
      const liveRel = archived ? rel.slice(ARCHIVE_DIR.length + 1) : rel;
      const { agent, project } = placeOf(liveRel);
      out.push({
        rel, abs, name: e.name, kind, agent, project, archived,
        mtimeMs: st.mtimeMs, size: st.size,
        unseen: !archived && !(seen[rel] && seen[rel] >= Math.floor(st.mtimeMs))
      });
      if (out.length >= MAX_ITEMS) return;
    }
  };
  walk(root, 0, false);
  const arch = join(root, ARCHIVE_DIR);
  if (existsSync(arch)) walk(arch, 1, true);
  // A picture a page references is that page's asset, not a deliverable of
  // its own: the post shows once, not as a post plus its hero image.
  const assets = new Set<string>();
  for (const i of out) {
    if (i.kind !== 'page' || i.size > 2_000_000) continue;
    let html = '';
    try { html = readFileSync(i.abs, 'utf8'); } catch { continue; }
    for (const a of pageAssets(html)) assets.add(resolve(dirname(i.abs), a));
  }
  const kept = assets.size ? out.filter((i) => !(i.kind === 'image' && assets.has(resolve(i.abs)))) : out;
  kept.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return kept;
}

/** Relative asset paths a page references (src/href/url()), for moving a page
 *  together with its pictures and styles. Only same-folder-or-below relatives;
 *  absolute URLs and parent-walking paths are ignored. */
export function pageAssets(html: string): string[] {
  const out = new Set<string>();
  const re = /(?:src|href)\s*=\s*["']([^"'#?]+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    if (!raw || /^(?:[a-z]+:|\/\/|\/|#)/i.test(raw) || raw.includes('..') || raw.includes('\\')) continue;
    out.add(raw.replace(/^\.\//, ''));
  }
  return [...out];
}

export class ShowcaseStore {
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly root: string) {}

  ensure(): void {
    try { mkdirSync(this.root, { recursive: true }); } catch { /* read-only home: listing is empty */ }
  }

  list(): ShowcaseItem[] {
    if (!existsSync(this.root)) return [];
    return listDeliverables(this.root, readState(this.root).seen);
  }

  unseenCount(): number {
    return this.list().filter((i) => i.unseen).length;
  }

  /** Remember that the human opened `rel` as it is now. */
  markSeen(rel: string): boolean {
    const abs = this.resolveRel(rel);
    if (!abs) return false;
    let mtime = Date.now();
    try { mtime = Math.floor(statSync(abs).mtimeMs); } catch { /* keep now */ }
    const state = readState(this.root);
    state.seen[rel] = mtime;
    // Drop entries for files that are gone so the state file cannot grow forever.
    for (const k of Object.keys(state.seen)) {
      if (k !== rel && !existsSync(this.resolveRel(k) ?? '')) delete state.seen[k];
    }
    try { writeFileSync(join(this.root, STATE_FILE), JSON.stringify(state, null, 2)); } catch { return false; }
    return true;
  }

  /** Move an item into `<agent>/<project>/` (project null = straight under the
   *  agent). A page travels with the relative assets it references. The seen
   *  mark follows the file. Returns the new id. */
  move(rel: string, project: string | null): { ok: true; rel: string } | { ok: false; error: string } {
    const abs = this.resolveRel(rel);
    if (!abs || !existsSync(abs)) return { ok: false, error: 'missing' };
    const archived = rel.startsWith(`${ARCHIVE_DIR}/`);
    const liveRel = archived ? rel.slice(ARCHIVE_DIR.length + 1) : rel;
    const { agent } = placeOf(liveRel);
    if (!agent) return { ok: false, error: 'an item at the root has no agent folder to file under' };
    const slug = project === null ? null : slugProject(project);
    if (project !== null && !slug) return { ok: false, error: 'bad project name' };
    const destDirRel = [archived ? ARCHIVE_DIR : null, agent, slug].filter((x): x is string => !!x).join('/');
    return this.relocate(rel, destDirRel);
  }

  /** Put an item away (or bring it back): the same place under .archive/. */
  setArchived(rel: string, archived: boolean): { ok: true; rel: string } | { ok: false; error: string } {
    const isArchived = rel.startsWith(`${ARCHIVE_DIR}/`);
    if (isArchived === archived) return { ok: true, rel };
    const liveRel = isArchived ? rel.slice(ARCHIVE_DIR.length + 1) : rel;
    const dirRel = liveRel.includes('/') ? liveRel.slice(0, liveRel.lastIndexOf('/')) : '';
    const destDirRel = archived ? [ARCHIVE_DIR, dirRel].filter(Boolean).join('/') : dirRel;
    return this.relocate(rel, destDirRel);
  }

  private relocate(rel: string, destDirRel: string): { ok: true; rel: string } | { ok: false; error: string } {
    const abs = this.resolveRel(rel);
    const destDir = this.resolveRel(destDirRel || '.');
    if (!abs || !destDir) return { ok: false, error: 'bad path' };
    const name = basename(abs);
    const destAbs = join(destDir, name);
    const newRel = [destDirRel, name].filter(Boolean).join('/');
    if (destAbs === abs) return { ok: true, rel };
    if (existsSync(destAbs)) return { ok: false, error: 'a file with that name is already there' };
    try { mkdirSync(destDir, { recursive: true }); } catch { /* rename reports it */ }
    // Companions: the page's own relative assets, moved only when nothing else
    // in the folder is a deliverable that might share them.
    const companions: Array<[string, string]> = [];
    if (showcaseKind(name) === 'page') {
      let html = '';
      try { html = readFileSync(abs, 'utf8'); } catch { html = ''; }
      const srcDir = dirname(abs);
      for (const a of pageAssets(html)) {
        const from = resolve(srcDir, a);
        // Pictures and styles travel; another page, PDF or report does not.
        const k = showcaseKind(from);
        if (!from.startsWith(srcDir + sep) || !existsSync(from) || (k && k !== 'image')) continue;
        companions.push([from, resolve(destDir, a)]);
      }
    }
    try {
      renameSync(abs, destAbs);
      for (const [from, to] of companions) {
        try { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); } catch { /* leave the asset */ }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // The seen mark follows the file.
    const state = readState(this.root);
    if (state.seen[rel] !== undefined) {
      state.seen[newRel] = state.seen[rel];
      delete state.seen[rel];
      try { writeFileSync(join(this.root, STATE_FILE), JSON.stringify(state, null, 2)); } catch { /* best-effort */ }
    }
    return { ok: true, rel: newRel };
  }

  /** The absolute path for an item id, or null when it would leave the root. */
  resolveRel(rel: string): string | null {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
    const abs = resolve(this.root, rel);
    const rootAbs = resolve(this.root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
    return abs;
  }

  /** Call `onChange` (debounced) whenever anything under the root changes. */
  watch(onChange: () => void): void {
    if (this.watcher) return;
    this.ensure();
    try {
      this.watcher = watch(this.root, { recursive: true }, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { this.debounce = null; onChange(); }, 400);
      });
      this.watcher.on('error', () => { this.stop(); });
    } catch {
      this.watcher = null; // recursive watch unsupported: the renderer polls instead
    }
  }

  stop(): void {
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
    try { this.watcher?.close(); } catch { /* noop */ }
    this.watcher = null;
  }
}

/** Decide what a cth-showcase:// request gets. Pure: returns the file to
 *  stream and its type, or a status to refuse with. */
export function planServe(url: string, exists: (p: string) => boolean = existsSync): { file: string; mime: string } | { status: number } {
  const file = pathFromShowcaseUrl(url);
  if (!file) return { status: 400 };
  const ext = extOf(file);
  if (!SERVABLE_EXTS.has(ext)) return { status: 403 };
  if (!exists(file)) return { status: 404 };
  return { file, mime: MIME_BY_EXT[ext] };
}

/** The protocol.handle callback. */
export function serveShowcase(request: { url: string }): Response {
  const plan = planServe(request.url);
  if ('status' in plan) return new Response(null, { status: plan.status });
  let st: ReturnType<typeof statSync>;
  try { st = statSync(plan.file); } catch { return new Response(null, { status: 404 }); }
  if (!st.isFile()) return new Response(null, { status: 404 });
  const body = Readable.toWeb(createReadStream(plan.file)) as unknown as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': plan.mime,
      'Content-Length': String(st.size),
      // A page is shown as-is but may not run anything or reach the network:
      // the iframe is sandboxed without scripts, and this backs that up.
      'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
      'Cache-Control': 'no-store'
    }
  });
}
