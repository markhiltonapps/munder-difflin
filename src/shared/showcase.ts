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
