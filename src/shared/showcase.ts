/**
 * Showcase — the shelf where agents put work meant for the human's eyes.
 *
 * Agents save finished deliverables (a social post as a web page, an image, a
 * PDF, a markdown report) under `<hive>/showcase/<agent-id>/…`. The app
 * watches that folder and shows every file as it lands, rendered the way it
 * is meant to be seen, with a badge for the ones not looked at yet. No link
 * to copy, no browser to open.
 *
 * Shared between main (the store and the file-serving protocol) and the
 * renderer (the gallery), so both agree on what counts as a deliverable and
 * how a file is addressed.
 */

export type ShowcaseKind = 'page' | 'image' | 'pdf' | 'markdown';

export interface ShowcaseItem {
  /** Path relative to the showcase root, forward slashes. The stable id. */
  rel: string;
  abs: string;
  name: string;
  kind: ShowcaseKind;
  /** First folder under the root, which the protocol asks agents to make their id. */
  agent: string | null;
  /** Second folder, the project the deliverable belongs to; null = unsorted. */
  project: string | null;
  /** Reviewed and put away under .archive/. Hidden from the shelf by default. */
  archived: boolean;
  mtimeMs: number;
  size: number;
  /** Not opened since it last changed. */
  unseen: boolean;
}

const KIND_BY_EXT: Record<string, ShowcaseKind> = {
  html: 'page', htm: 'page',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown'
};

export type ShowcaseGroupBy = 'employee' | 'project' | 'date' | 'type';
export const SHOWCASE_GROUP_MODES: ShowcaseGroupBy[] = ['employee', 'project', 'date', 'type'];

/** The folder archived deliverables move into (mirrors the live tree). */
export const ARCHIVE_DIR = '.archive';

/** A project folder name an agent or the owner may use: plain words, no path tricks. */
export function slugProject(name: string): string | null {
  const s = name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || null;
}

export interface ShowcaseGroup { key: string; label: string; items: ShowcaseItem[]; unseen: number }

/** Group a list for the shelf. Labels for employee/project are raw keys; the
 *  renderer maps agent ids to names and translates the date/type buckets. */
export function groupItems(items: ShowcaseItem[], mode: ShowcaseGroupBy, now: number = Date.now()): ShowcaseGroup[] {
  const buckets = new Map<string, ShowcaseItem[]>();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const keyOf = (i: ShowcaseItem): string => {
    switch (mode) {
      case 'employee': return i.agent ?? '';
      case 'project': return i.project ?? '';
      case 'type': return i.kind;
      case 'date': {
        if (i.mtimeMs >= dayStart.getTime()) return 'today';
        if (i.mtimeMs >= dayStart.getTime() - 6 * 86_400_000) return 'week';
        if (i.mtimeMs >= dayStart.getTime() - 29 * 86_400_000) return 'month';
        return 'older';
      }
    }
  };
  for (const i of items) {
    const k = keyOf(i);
    const b = buckets.get(k); if (b) b.push(i); else buckets.set(k, [i]);
  }
  const order = mode === 'date' ? ['today', 'week', 'month', 'older'] : mode === 'type' ? ['page', 'image', 'pdf', 'markdown'] : null;
  const keys = [...buckets.keys()].sort((a, b) => {
    if (order) return order.indexOf(a) - order.indexOf(b);
    if (a === '') return 1; if (b === '') return -1; // unsorted / no agent last
    return a.localeCompare(b);
  });
  return keys.map((key) => {
    const list = buckets.get(key)!;
    return { key, label: key, items: list, unseen: list.filter((i) => i.unseen).length };
  });
}

/** Case-insensitive match on name, agent and project. */
export function matchesSearch(i: ShowcaseItem, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [i.name, i.agent ?? '', i.project ?? '', i.rel].some((v) => v.toLowerCase().includes(s));
}

export function extOf(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? m[1].toLowerCase() : '';
}

/** The kind a file is shown as, or null when it is not a deliverable we render. */
export function showcaseKind(p: string): ShowcaseKind | null {
  return KIND_BY_EXT[extOf(p)] ?? null;
}

export const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', json: 'application/json',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav'
};

/** What the protocol will serve. A page's own assets (css, images, fonts) are
 *  included so a deliverable can reference them relatively; code and data files
 *  that are not part of a page are not. */
export const SERVABLE_EXTS = new Set(Object.keys(MIME_BY_EXT));

/** The custom scheme the renderer loads deliverables through. One origin per
 *  file, chosen so a sandboxed page cannot name anything but its own folder. */
export const SHOWCASE_SCHEME = 'cth-showcase';

/** Base64url without padding — safe inside a URL path on every platform. */
export function encodeAbs(abs: string): string {
  const b64 = typeof Buffer !== 'undefined'
    ? Buffer.from(abs, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(abs)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeAbs(token: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (token.length % 4)) % 4);
  try {
    return typeof Buffer !== 'undefined'
      ? Buffer.from(b64, 'base64').toString('utf8')
      : decodeURIComponent(escape(atob(b64)));
  } catch {
    return null;
  }
}

/** URL that serves `abs` (a file on this machine) to the renderer. Relative
 *  references inside a page resolve under the same folder:
 *  `cth-showcase://f/<token-of-folder>/<file name>`. */
export function showcaseUrl(abs: string): string {
  const norm = abs.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const dir = slash >= 0 ? norm.slice(0, slash) : '';
  const name = slash >= 0 ? norm.slice(slash + 1) : norm;
  return `${SHOWCASE_SCHEME}://f/${encodeAbs(dir)}/${encodeURIComponent(name).replace(/%2F/gi, '/')}`;
}

/** Inverse of showcaseUrl for the protocol handler. Returns the absolute path
 *  the URL names, or null when the URL is not ours or escapes its folder. */
export function pathFromShowcaseUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${SHOWCASE_SCHEME}:` || u.host !== 'f') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const dir = decodeAbs(parts[0]);
  // A page that walks `..` past its own name lands on a stray segment where the
  // token should be. Only a token that decodes to an absolute folder AND
  // re-encodes to itself is ours; anything else is refused.
  if (dir === null || encodeAbs(dir) !== parts[0]) return null;
  if (!(dir.startsWith('/') || /^[A-Za-z]:\//.test(dir))) return null;
  const rest = parts.slice(1).map((p) => { try { return decodeURIComponent(p); } catch { return '\0'; } });
  // Each decoded segment is one file-name: no separators, no dot-dot.
  if (rest.some((p) => !p || p === '..' || p === '.' || p.includes('/') || p.includes('\\') || p.includes('\0'))) return null;
  return `${dir}/${rest.join('/')}`;
}
