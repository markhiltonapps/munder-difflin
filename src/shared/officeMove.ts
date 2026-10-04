/**
 * Moving the office between computers — the pure half.
 *
 * An export is one `.tar.gz` holding the harness home's durable folders, the
 * settings file and a manifest. The hard part of an import is not the copy,
 * it is that every path inside was written on the OTHER machine: agent
 * working directories, worktrees, the home itself. This module decides which
 * roots those paths share, guesses where each root lives on the new machine,
 * and rewrites strings accordingly. Main does the file I/O; the Settings UI
 * shows the guesses for the user to correct. No Electron, no fs.
 */

export const MANIFEST_VERSION = 1;
/** Where the manifest and settings sit inside the archive. */
export const ARCHIVE_META_DIR = '.office-move';
/** The folders under the harness home that make up the office. `worktrees`
 *  is deliberately absent: a git worktree is bound to its main checkout by
 *  absolute path and cannot be moved; the agent's branch travels with the
 *  repository instead. */
export const OFFICE_FOLDERS = ['hive', 'palace', 'roster.json', 'roster-backups', 'stapler'] as const;

export type Platform = 'win32' | 'darwin' | 'linux';

export interface OfficeManifest {
  version: number;
  exportedAt: string;
  appVersion: string;
  platform: Platform;
  /** The user's home directory on the source machine, if it could be told. */
  userHome: string | null;
  harnessHome: string;
  agentCount: number;
  /** Distinct parent directories the agents work in, longest first. */
  roots: string[];
  /** Labels of secrets that live in the OS keychain and will not travel. */
  secretsToReenter: string[];
  /** Which OFFICE_FOLDERS were present and packed. */
  included: string[];
}

export interface PathMapping { from: string; to: string }

export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function sepOf(platform: Platform): string { return platform === 'win32' ? '\\' : '/'; }

/** Trailing separators off, so "C:\\a\\" and "C:\\a" are one root. */
export function trimSep(p: string): string {
  return p.replace(/[\\/]+$/, '') || p;
}

/** The directory above a path, in that path's own separator style. */
export function parentOf(p: string): string {
  const t = trimSep(p);
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (i <= 0) return t;
  // Keep "C:\\" and "/" intact.
  const head = t.slice(0, i);
  if (/^[A-Za-z]:$/.test(head)) return head + t[i];
  return head || t[i];
}

/** Distinct parents of the given absolute paths, longest first so a
 *  longest-prefix match finds the most specific root. */
export function pathRootsOf(paths: Array<string | undefined | null>): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const t = trimSep(p.trim());
    if (!isWindowsPath(t) && !t.startsWith('/')) continue; // relative: nothing to map
    set.add(parentOf(t));
  }
  return [...set].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** "C:\\Users\\mark" from "C:\\Users\\mark\\work\\api"; "/Users/mark" from a Mac
 *  path; "/home/mark" on Linux. Null when the path is not under a user home. */
export function userHomeOf(p: string): string | null {
  const m = p.match(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/) ?? p.match(/^(\/Users\/[^/]+)/) ?? p.match(/^(\/home\/[^/]+)/);
  return m ? m[1] : null;
}

/** Where a source root probably lives on this machine: the part under the
 *  old user home re-rooted under the new one, in the new platform's style.
 *  A root outside any user home (D:\\projects) keeps its tail under the new
 *  home, which is a guess the user will see and can change. */
export function guessTarget(root: string, sourceUserHome: string | null, targetUserHome: string, target: Platform): string {
  const sep = sepOf(target);
  const home = sourceUserHome ?? userHomeOf(root);
  let tail: string;
  if (home && root.toLowerCase().startsWith(home.toLowerCase())) {
    tail = root.slice(home.length);
  } else if (isWindowsPath(root)) {
    tail = root.replace(/^[A-Za-z]:/, '');
  } else {
    tail = root;
  }
  const parts = tail.split(/[\\/]+/).filter(Boolean);
  return parts.length ? trimSep(targetUserHome) + sep + parts.join(sep) : trimSep(targetUserHome);
}

/** Rewrite one path: longest matching `from` wins; the remainder's separators
 *  are converted to the target platform's. Windows prefixes compare
 *  case-insensitively. Anything that matches no root is returned unchanged. */
export function remapPath(p: string, mapping: PathMapping[], target: Platform): string {
  const sep = sepOf(target);
  const sorted = [...mapping].filter((m) => m.from && m.to).sort((a, b) => b.from.length - a.from.length);
  for (const m of sorted) {
    const from = trimSep(m.from);
    const ci = isWindowsPath(from);
    const head = p.slice(0, from.length);
    const matches = ci ? head.toLowerCase() === from.toLowerCase() : head === from;
    if (!matches) continue;
    const rest = p.slice(from.length);
    // A root must match at a boundary: "C:\\work" must not catch "C:\\workshop".
    if (rest && !/^[\\/]/.test(rest)) continue;
    const tail = rest.split(/[\\/]/).join(sep);
    return trimSep(m.to) + tail;
  }
  return p;
}

/** True when a string looks like one of the mapped roots or something under it. */
export function isMappedPath(s: string, mapping: PathMapping[]): boolean {
  return mapping.some((m) => remapPath(s, [m], 'linux') !== s || remapPath(s, [m], 'win32') !== s);
}

/** Walk any JSON value and rewrite every string that is a mapped path. */
export function remapJson<T>(value: T, mapping: PathMapping[], target: Platform): T {
  if (typeof value === 'string') return (isMappedPath(value, mapping) ? remapPath(value, mapping, target) : value) as T;
  if (Array.isArray(value)) return value.map((v) => remapJson(v, mapping, target)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = remapJson(v, mapping, target);
    return out as T;
  }
  return value;
}

/** Rewrite paths inside prose (an agent's memory.md mentions its folders).
 *  Each occurrence of a root, followed by a boundary, is replaced, and the
 *  path that follows it has its separators converted up to the next
 *  whitespace or quote. */
export function remapText(text: string, mapping: PathMapping[], target: Platform): string {
  const sep = sepOf(target);
  let out = text;
  const sorted = [...mapping].filter((m) => m.from && m.to).sort((a, b) => b.from.length - a.from.length);
  for (const m of sorted) {
    const from = trimSep(m.from);
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The root must end at a boundary (separator, space, quote, end) so
    // "C:\\work" never catches "C:\\workshop"; the tail then runs to the next
    // whitespace or quote.
    const re = new RegExp(`${escaped}(?=$|[\\\\/\\s"'\`<>|)\\]])((?:[\\\\/][^\\s"'\`<>|)\\]]*)?)`, isWindowsPath(from) ? 'gi' : 'g');
    out = out.replace(re, (_all, tail: string) => trimSep(m.to) + (tail ?? '').split(/[\\/]/).join(sep));
  }
  return out;
}

/** Files under the office worth rewriting: the registries, the roster, notes
 *  and logs. Binary indexes and audio-free transcripts' JSON are fine too,
 *  but anything large is left alone. */
export const REWRITE_EXTENSIONS = new Set(['.json', '.md', '.jsonl', '.txt', '.toml', '.yaml', '.yml']);
export const REWRITE_MAX_BYTES = 24 * 1024 * 1024;

export function defaultArchiveName(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
  return `munder-difflin-office-${stamp}.tar.gz`;
}
