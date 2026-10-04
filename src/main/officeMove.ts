/**
 * Moving the office between computers — the file half, in the main process.
 *
 * EXPORT packs the harness home's office folders (hive, palace, roster,
 * stapler — never worktrees), the settings file and a manifest into one
 * `.tar.gz`. The manifest records the machine's platform, user home and
 * every root the agents worked under, which is what the import needs to
 * ask the right questions.
 *
 * IMPORT unpacks into the chosen home, then walks the text files (JSON, md,
 * jsonl…) rewriting every path from the old roots to where the user says they
 * live now, and returns the settings to apply. It never deletes anything
 * that was already in the target; the caller decides whether the target may
 * be a home that already holds an office.
 *
 * Deliberately free of `electron` so the tests can drive it on a temp dir.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import * as tar from 'tar';
import {
  ARCHIVE_META_DIR, MANIFEST_VERSION, OFFICE_FOLDERS, REWRITE_EXTENSIONS, REWRITE_MAX_BYTES,
  pathRootsOf, remapJson, remapText,
  type OfficeManifest, type PathMapping, type Platform
} from '../shared/officeMove';

export interface ExportArgs {
  home: string;
  /** The settings file's contents (already read by the caller). */
  config: Record<string, unknown>;
  dest: string;
  appVersion: string;
  platform: Platform;
  userHome: string | null;
  secretsToReenter: string[];
}

/** Agent working directories, from the registry if it can be read. */
function agentCwds(home: string): string[] {
  const out: string[] = [];
  try {
    const reg = JSON.parse(readFileSync(join(home, 'hive', 'registry.json'), 'utf8')) as { agents?: unknown };
    const agents = Array.isArray(reg.agents) ? reg.agents
      : reg.agents && typeof reg.agents === 'object' ? Object.values(reg.agents) : [];
    for (const a of agents as Array<{ cwd?: unknown; worktreePath?: unknown }>) {
      if (typeof a?.cwd === 'string') out.push(a.cwd);
      if (typeof a?.worktreePath === 'string') out.push(a.worktreePath);
    }
  } catch { /* no registry yet */ }
  try {
    const roster = JSON.parse(readFileSync(join(home, 'roster.json'), 'utf8')) as { agents?: Array<{ cwd?: unknown; worktreePath?: unknown }> };
    for (const a of roster.agents ?? []) {
      if (typeof a?.cwd === 'string') out.push(a.cwd);
      if (typeof a?.worktreePath === 'string') out.push(a.worktreePath);
    }
  } catch { /* no roster */ }
  return out;
}

export function buildManifest(args: Omit<ExportArgs, 'dest' | 'config'>): OfficeManifest {
  const cwds = agentCwds(args.home);
  const included = OFFICE_FOLDERS.filter((f) => existsSync(join(args.home, f)));
  let agentCount = 0;
  try {
    const reg = JSON.parse(readFileSync(join(args.home, 'hive', 'registry.json'), 'utf8')) as { agents?: unknown };
    agentCount = Array.isArray(reg.agents) ? reg.agents.length
      : reg.agents && typeof reg.agents === 'object' ? Object.keys(reg.agents).length : 0;
  } catch { /* none */ }
  return {
    version: MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: args.appVersion,
    platform: args.platform,
    userHome: args.userHome,
    harnessHome: args.home,
    agentCount,
    roots: pathRootsOf([...cwds, args.home]),
    secretsToReenter: args.secretsToReenter,
    included: [...included]
  };
}

export async function exportOffice(args: ExportArgs): Promise<{ ok: true; path: string; manifest: OfficeManifest } | { ok: false; error: string }> {
  const meta = join(args.home, ARCHIVE_META_DIR);
  try {
    const manifest = buildManifest(args);
    if (manifest.included.length === 0) return { ok: false, error: 'nothing to export: no office in this home yet' };
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    writeFileSync(join(meta, 'config.json'), JSON.stringify(args.config, null, 2), 'utf8');
    await tar.create(
      {
        gzip: true, file: args.dest, cwd: args.home, portable: true,
        // Worktrees never travel (see OFFICE_FOLDERS); nothing else under the
        // packed folders is excluded.
        filter: (p) => !/(^|[\\/])node_modules([\\/]|$)/.test(p)
      },
      [ARCHIVE_META_DIR, ...manifest.included]
    );
    return { ok: true, path: args.dest, manifest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(meta, { recursive: true, force: true });
  }
}

/** Read just the manifest out of an archive. */
export async function inspectArchive(archive: string): Promise<{ ok: true; manifest: OfficeManifest } | { ok: false; error: string }> {
  const tmp = mkdtempSync(join(tmpdir(), 'office-inspect-'));
  try {
    const want = `${ARCHIVE_META_DIR}/manifest.json`;
    await tar.extract({ file: archive, cwd: tmp, filter: (p) => p.replace(/\\/g, '/') === want || p.replace(/\\/g, '/') === `./${want}` });
    const p = join(tmp, ARCHIVE_META_DIR, 'manifest.json');
    if (!existsSync(p)) return { ok: false, error: 'not an office export (no manifest inside)' };
    const m = JSON.parse(readFileSync(p, 'utf8')) as OfficeManifest;
    if (m.version !== MANIFEST_VERSION) return { ok: false, error: `export version ${m.version} is not supported by this build` };
    return { ok: true, manifest: m };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface ImportArgs {
  archive: string;
  newHome: string;
  mapping: PathMapping[];
  target: Platform;
}

export interface ImportResult {
  ok: true;
  /** The exported settings, paths rewritten, for the caller to merge. */
  config: Record<string, unknown>;
  manifest: OfficeManifest;
  rewrittenFiles: number;
  warnings: string[];
}

/** Every file under `dir` (recursive), relative to it. */
function walk(dir: string, out: string[] = [], base = dir): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, base);
    else if (e.isFile()) out.push(relative(base, p));
  }
  return out;
}

/** Rewrite paths in every text file of the imported office. JSON is parsed and
 *  walked (so only string values change and the file stays valid); other text
 *  is rewritten as prose. A file that fails to parse as JSON is treated as
 *  text rather than skipped. */
export function rewritePaths(home: string, mapping: PathMapping[], target: Platform, folders: readonly string[] = OFFICE_FOLDERS): { files: number; warnings: string[] } {
  const warnings: string[] = [];
  let files = 0;
  if (mapping.length === 0) return { files, warnings };
  for (const f of folders) {
    const root = join(home, f);
    if (!existsSync(root)) continue;
    const entries = statSync(root).isDirectory() ? walk(root).map((r) => join(root, r)) : [root];
    for (const p of entries) {
      const ext = extname(p).toLowerCase();
      if (!REWRITE_EXTENSIONS.has(ext)) continue;
      let size = 0;
      try { size = statSync(p).size; } catch { continue; }
      if (size > REWRITE_MAX_BYTES) { warnings.push(`skipped ${relative(home, p)} (too large to rewrite)`); continue; }
      try {
        const text = readFileSync(p, 'utf8');
        let next: string;
        if (ext === '.json') {
          try { next = JSON.stringify(remapJson(JSON.parse(text), mapping, target), null, 2) + '\n'; }
          catch { next = remapText(text, mapping, target); }
        } else {
          next = remapText(text, mapping, target);
        }
        if (next !== text) { writeFileSync(p, next, 'utf8'); files += 1; }
      } catch (e) {
        warnings.push(`could not rewrite ${relative(home, p)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { files, warnings };
}

export async function importOffice(args: ImportArgs): Promise<ImportResult | { ok: false; error: string }> {
  const inspected = await inspectArchive(args.archive);
  if (!inspected.ok) return inspected;
  const manifest = inspected.manifest;
  try {
    mkdirSync(args.newHome, { recursive: true });
    // Unpack the office folders straight into the new home; the metadata goes
    // to a temp dir so nothing of the archive's own bookkeeping lands there.
    await tar.extract({
      file: args.archive, cwd: args.newHome,
      filter: (p) => !p.replace(/\\/g, '/').replace(/^\.\//, '').startsWith(`${ARCHIVE_META_DIR}/`)
    });
    const tmp = mkdtempSync(join(tmpdir(), 'office-import-'));
    let config: Record<string, unknown> = {};
    try {
      await tar.extract({ file: args.archive, cwd: tmp, filter: (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').startsWith(`${ARCHIVE_META_DIR}/`) });
      const cp = join(tmp, ARCHIVE_META_DIR, 'config.json');
      if (existsSync(cp)) config = JSON.parse(readFileSync(cp, 'utf8')) as Record<string, unknown>;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    // The old home itself is a root too: anything that pointed inside it now
    // points inside the new one.
    const mapping: PathMapping[] = [...args.mapping, { from: manifest.harnessHome, to: args.newHome }];
    const { files, warnings } = rewritePaths(args.newHome, mapping, args.target);
    const remappedConfig = remapJson(config, mapping, args.target);
    remappedConfig.harnessHome = args.newHome;
    return { ok: true, config: remappedConfig, manifest, rewrittenFiles: files, warnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The target platform's separator, for the renderer's guesses. */
export function platformSep(): string { return sep; }
