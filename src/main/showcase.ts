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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { MIME_BY_EXT, SERVABLE_EXTS, extOf, pathFromShowcaseUrl, showcaseKind, type ShowcaseItem } from '../shared/showcase';

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

/** Pure listing over a directory tree, exported for the tests. */
export function listDeliverables(root: string, seen: Record<string, number>): ShowcaseItem[] {
  const out: ShowcaseItem[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_ITEMS) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!e.isFile()) continue;
      const kind = showcaseKind(e.name);
      if (!kind) continue;
      let st: ReturnType<typeof statSync>;
      try { st = statSync(abs); } catch { continue; }
      const rel = relative(root, abs).split(sep).join('/');
      const agent = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : null;
      out.push({
        rel, abs, name: e.name, kind, agent,
        mtimeMs: st.mtimeMs, size: st.size,
        unseen: !(seen[rel] && seen[rel] >= Math.floor(st.mtimeMs))
      });
      if (out.length >= MAX_ITEMS) return;
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
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
