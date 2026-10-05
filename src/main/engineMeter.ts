/**
 * Engine meter — token usage for engines that do not report it themselves.
 *
 * Claude agents report usage through Claude's telemetry, and the proxy
 * engines (qwen, crush) through the sidecar that forwards their traffic. Two
 * popular engines do neither, but both keep exact per-message token counts
 * on disk (verified against the published packages, see
 * docs/research/engine-usage-metering.md):
 *
 *   OpenCode   — a SQLite database. Each agent is spawned with OPENCODE_DB
 *                pointing into its own hive folder, so the mapping from
 *                session to agent is the file itself. Assistant messages carry
 *                tokens.{input, output, reasoning, cache.{read, write}},
 *                modelID / providerID and time.completed.
 *   Gemini CLI — chat logs under ~/.gemini/tmp/<project>/chats/*.jsonl. A
 *                record of type "gemini" carries tokens.{input, output,
 *                cached, thoughts, tool} and the model. A session is matched to
 *                the Gemini agent whose working folder is that project and
 *                that was running when the session started.
 *
 * Every metered message becomes one per-request row in the cost ledger
 * (session ids start with `proxy-` so the Payroll fold adds them as
 * increments). A small state file beside each agent remembers what has been
 * counted, so nothing is double-counted across app restarts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { AgentUsageSample } from './usage';
import { estimateCostUsd } from './pricing';

export interface MeterAgent {
  id: string;
  provider: string;
  cwd: string;
  /** ms epoch when the agent was (last) spawned by this app. */
  spawnedAt: number;
  archived: boolean;
}

export interface MeterDeps {
  hiveRoot: () => string | null;
  agents: () => MeterAgent[];
  append: (sample: AgentUsageSample) => void;
  /** Open a SQLite file read-only; null when unavailable. */
  openDb: (path: string) => DbLike | null;
  geminiHome?: () => string;
  now?: () => number;
}

export interface DbLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

interface MeterState {
  opencode?: { cursor: number; seen: string[] };
  gemini?: { seen: string[] };
}

const STATE_FILE = '.engine-meter.json';
const SEEN_CAP = 4000;

// ── OpenCode ──────────────────────────────────────────────────────────────────

export interface OpencodeRow { id: string; session_id: string; time_updated: number; data: string }

/** Assistant messages that are complete and not yet counted → ledger rows. */
export function opencodeSamples(rows: OpencodeRow[], agentId: string, seen: Set<string>): { samples: AgentUsageSample[]; cursor: number } {
  const samples: AgentUsageSample[] = [];
  let cursor = 0;
  for (const r of rows) {
    cursor = Math.max(cursor, Number(r.time_updated) || 0);
    if (seen.has(r.id)) continue;
    let d: { role?: string; modelID?: string; providerID?: string; cost?: number; time?: { created?: number; completed?: number }; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }; finish?: unknown; error?: unknown };
    try { d = JSON.parse(r.data); } catch { continue; }
    if (d.role !== 'assistant' || !d.tokens) continue;
    const done = !!(d.time?.completed || d.finish || d.error);
    if (!done) continue;
    const input = Number(d.tokens.input) || 0;
    const output = (Number(d.tokens.output) || 0) + (Number(d.tokens.reasoning) || 0);
    const cacheRead = Number(d.tokens.cache?.read) || 0;
    const cacheCreation = Number(d.tokens.cache?.write) || 0;
    if (input + output + cacheRead + cacheCreation <= 0) { seen.add(r.id); continue; }
    const model = [d.providerID, d.modelID].filter(Boolean).join('/') || null;
    const ts = Number(d.time?.completed) || Number(d.time?.created) || Number(r.time_updated) || Date.now();
    samples.push({
      agentId, sessionId: `proxy-oc-${r.session_id}`, ts, input, output, cacheRead, cacheCreation, model,
      usd: typeof d.cost === 'number' && d.cost > 0 ? d.cost : estimateCostUsd(model, { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheCreation })
    });
    seen.add(r.id);
  }
  return { samples, cursor };
}

// ── Gemini CLI ────────────────────────────────────────────────────────────────

export interface GeminiRecord { id: string; type: string; timestamp?: string; model?: string; tokens?: { input?: number; output?: number; cached?: number; thoughts?: number; tool?: number } }
export interface GeminiChat { sessionId: string | null; startTime: number; records: GeminiRecord[] }

/** Replay a chats .jsonl: line 1 is metadata; a full record replaces by id
 *  (last write wins); `$set` may carry messages or metadata; `$rewindTo` drops
 *  everything after the named record. */
export function parseGeminiChat(text: string): GeminiChat {
  const out: GeminiChat = { sessionId: null, startTime: 0, records: [] };
  const byId = new Map<string, GeminiRecord>();
  const order: string[] = [];
  const upsert = (rec: GeminiRecord): void => {
    if (!rec || typeof rec.id !== 'string') return;
    if (!byId.has(rec.id)) order.push(rec.id);
    byId.set(rec.id, rec);
  };
  let first = true;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
    if (first) {
      first = false;
      if (typeof obj.sessionId === 'string') {
        out.sessionId = obj.sessionId;
        out.startTime = Date.parse(String(obj.startTime ?? '')) || 0;
        continue;
      }
    }
    if (obj.$set && typeof obj.$set === 'object') {
      const set = obj.$set as { messages?: GeminiRecord[]; sessionId?: string; startTime?: string };
      if (Array.isArray(set.messages)) for (const m of set.messages) upsert(m);
      if (typeof set.sessionId === 'string') out.sessionId = set.sessionId;
      if (typeof set.startTime === 'string') out.startTime = Date.parse(set.startTime) || out.startTime;
      continue;
    }
    if (typeof obj.$rewindTo === 'string') {
      const idx = order.indexOf(obj.$rewindTo);
      if (idx >= 0) { for (const id of order.splice(idx + 1)) byId.delete(id); }
      continue;
    }
    upsert(obj as unknown as GeminiRecord);
  }
  out.records = order.map((id) => byId.get(id)!).filter(Boolean);
  return out;
}

/** Model replies with usage, not yet counted → ledger rows. Gemini counts
 *  cached tokens inside the prompt count, so input is the uncached part. */
export function geminiSamples(chat: GeminiChat, agentId: string, seen: Set<string>): AgentUsageSample[] {
  const samples: AgentUsageSample[] = [];
  for (const r of chat.records) {
    if (r.type !== 'gemini' || !r.tokens || seen.has(r.id)) continue;
    const prompt = Number(r.tokens.input) || 0;
    const cacheRead = Math.min(prompt, Number(r.tokens.cached) || 0);
    const input = prompt - cacheRead + (Number(r.tokens.tool) || 0);
    const output = (Number(r.tokens.output) || 0) + (Number(r.tokens.thoughts) || 0);
    if (input + output + cacheRead <= 0) { seen.add(r.id); continue; }
    const model = r.model ? `google/${r.model}` : 'google/gemini';
    samples.push({
      agentId, sessionId: `proxy-gm-${chat.sessionId ?? 'unknown'}`, ts: Date.parse(r.timestamp ?? '') || Date.now(),
      input, output, cacheRead, cacheCreation: 0, model,
      usd: estimateCostUsd(model, { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 })
    });
    seen.add(r.id);
  }
  return samples;
}

/** Same folder, whatever the slashes and case (Windows paths arrive both ways). */
export function sameDir(a: string, b: string): boolean {
  // Textual, not resolve(): a Windows path must compare the same on any host,
  // and Windows folders are case-insensitive.
  const n = (p: string): string => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
  return n(a) === n(b);
}

/** The chat files under ~/.gemini that belong to `cwd`: the project slug comes
 *  from projects.json, else from a .project_root marker in each tmp folder. */
export function geminiChatFilesFor(geminiHome: string, cwd: string): string[] {
  const tmp = join(geminiHome, 'tmp');
  if (!existsSync(tmp)) return [];
  const slugs = new Set<string>();
  try {
    const pj = JSON.parse(readFileSync(join(geminiHome, 'projects.json'), 'utf8')) as { projects?: Record<string, string> };
    for (const [p, slug] of Object.entries(pj.projects ?? {})) if (sameDir(p, cwd)) slugs.add(slug);
  } catch { /* no projects.json yet */ }
  let dirs: string[] = [];
  try { dirs = readdirSync(tmp); } catch { return []; }
  for (const d of dirs) {
    if (slugs.has(d)) continue;
    try {
      const marker = readFileSync(join(tmp, d, '.project_root'), 'utf8').trim();
      if (marker && sameDir(marker, cwd)) slugs.add(d);
    } catch { /* not a project dir */ }
  }
  const files: string[] = [];
  for (const slug of slugs) {
    const chats = join(tmp, slug, 'chats');
    let names: string[] = [];
    try { names = readdirSync(chats); } catch { continue; }
    for (const n of names) if (/^session-.*\.jsonl$/.test(n)) files.push(join(chats, n));
  }
  return files;
}

/** Which Gemini agent a session belongs to: the one in that folder that had
 *  been spawned most recently before the session started. */
export function pickGeminiOwner(agents: MeterAgent[], cwd: string, startTime: number): MeterAgent | null {
  const here = agents.filter((a) => a.provider === 'gemini' && sameDir(a.cwd, cwd) && a.spawnedAt <= startTime + 1_000);
  if (!here.length) return null;
  here.sort((x, y) => y.spawnedAt - x.spawnedAt);
  return here[0];
}

// ── the meter ─────────────────────────────────────────────────────────────────

export class EngineMeter {
  private busy = false;
  private lastTick = 0;
  /** Session file → the record ids already counted (kept in the owner's state). */
  constructor(private readonly deps: MeterDeps) {}

  private stateFile(agentId: string): string | null {
    const root = this.deps.hiveRoot();
    return root ? join(root, 'agents', agentId, STATE_FILE) : null;
  }
  private readState(agentId: string): MeterState {
    const p = this.stateFile(agentId);
    if (!p) return {};
    try { return JSON.parse(readFileSync(p, 'utf8')) as MeterState; } catch { return {}; }
  }
  private writeState(agentId: string, s: MeterState): void {
    const p = this.stateFile(agentId);
    if (!p) return;
    try { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(s)); } catch { /* best-effort */ }
  }

  /** The per-agent OpenCode database the agent is spawned with. */
  opencodeDbPath(agentId: string): string | null {
    const root = this.deps.hiveRoot();
    return root ? join(root, 'agents', agentId, 'opencode.db') : null;
  }

  /** Poll both engines. Cheap when nothing changed; never throws. */
  tick(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      const agents = this.deps.agents().filter((a) => !a.archived);
      for (const a of agents) {
        if (a.provider === 'opencode') this.meterOpencode(a);
      }
      this.meterGemini(agents);
      this.lastTick = (this.deps.now ?? Date.now)();
    } catch { /* keep the floor running */ } finally { this.busy = false; }
  }

  private meterOpencode(a: MeterAgent): void {
    const dbPath = this.opencodeDbPath(a.id);
    if (!dbPath || !existsSync(dbPath)) return;
    const state = this.readState(a.id);
    const oc = state.opencode ?? { cursor: 0, seen: [] };
    const db = this.deps.openDb(dbPath);
    if (!db) return;
    let rows: OpencodeRow[] = [];
    try {
      rows = db.prepare('SELECT id, session_id, time_updated, data FROM message WHERE time_updated >= ? ORDER BY time_updated ASC LIMIT 2000').all(oc.cursor) as OpencodeRow[];
    } catch { /* schema moved: skip quietly */ } finally { try { db.close(); } catch { /* noop */ } }
    if (!rows.length) return;
    const seen = new Set(oc.seen);
    const { samples, cursor } = opencodeSamples(rows, a.id, seen);
    for (const s of samples) this.deps.append(s);
    state.opencode = { cursor, seen: [...seen].slice(-SEEN_CAP) };
    this.writeState(a.id, state);
  }

  private meterGemini(agents: MeterAgent[]): void {
    const gem = agents.filter((a) => a.provider === 'gemini');
    if (!gem.length) return;
    const home = (this.deps.geminiHome ?? (() => process.env.GEMINI_CLI_HOME || join(homedir(), '.gemini')))();
    const cwds: string[] = [];
    for (const a of gem) if (!cwds.some((c) => sameDir(c, a.cwd))) cwds.push(a.cwd);
    const states = new Map<string, MeterState>();
    const dirty = new Set<string>();
    for (const cwd of cwds) {
      for (const file of geminiChatFilesFor(home, cwd)) {
        let st: ReturnType<typeof statSync>;
        try { st = statSync(file); } catch { continue; }
        // Only files touched since the last pass (first pass reads everything).
        if (this.lastTick && st.mtimeMs < this.lastTick - 60_000) continue;
        let chat: GeminiChat;
        try { chat = parseGeminiChat(readFileSync(file, 'utf8')); } catch { continue; }
        const owner = pickGeminiOwner(gem, cwd, chat.startTime || st.mtimeMs);
        if (!owner) continue;
        if (!states.has(owner.id)) states.set(owner.id, this.readState(owner.id));
        const state = states.get(owner.id)!;
        const g = state.gemini ?? { seen: [] };
        const seen = new Set(g.seen);
        const before = seen.size;
        for (const s of geminiSamples(chat, owner.id, seen)) this.deps.append(s);
        if (seen.size !== before) { state.gemini = { seen: [...seen].slice(-SEEN_CAP) }; dirty.add(owner.id); }
      }
    }
    for (const id of dirty) this.writeState(id, states.get(id)!);
  }
}

export const OPENCODE_DB_FILE = 'opencode.db';
export { sep as pathSep };
