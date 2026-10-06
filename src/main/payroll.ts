/**
 * Payroll — fold cost-ledger.jsonl into per-agent, per-window totals.
 *
 * Two kinds of row live in the ledger:
 *   - Claude Code telemetry rows are CUMULATIVE running totals per
 *     (agent, session). The spend in a window is the difference between
 *     consecutive rows; a drop means the app restarted and the counter began
 *     again, so the new value is the increment (same reading as
 *     costLifetime.ts).
 *   - Proxy-bridge rows (sessions named `proxy-…`, the non-Claude engines) are
 *     PER-REQUEST increments: each row is added as it is.
 *
 * Dollars: Claude rows carry Claude's own figure, so their deltas are used.
 * Every other row is re-priced here from its token deltas, because the figure
 * the ledger stored for them was a placeholder (Sonnet rates for everything).
 * A model with no price on file counts zero and is reported as unknown.
 */
import { readFile, stat } from 'node:fs/promises';
import { costFromPrice, normalizeModel, priceInfo } from './pricing';
import {
  addTotals, emptyWindows, zeroTotals,
  type PayrollAgent, type PayrollSummary, type PayrollTotals, type PayrollWindow
} from '../shared/payroll';

interface Row {
  agent_id: string; session_id: string | null; ts: number;
  input: number; output: number; cache_read: number; cache_creation: number;
  model: string | null; usd: number;
  /** The provider's own charge: never re-priced from tokens. */
  usd_exact?: boolean;
}

const EPS = 1e-9;
const DAY = 86_400_000;

export interface FoldClock {
  now: number;
  /** Local midnight for "today". */
  dayStart: number;
}

function parseRow(line: string): Row | null {
  if (!line.trim()) return null;
  try {
    const r = JSON.parse(line) as Partial<Row>;
    if (typeof r.agent_id !== 'string' || typeof r.ts !== 'number') return null;
    return {
      agent_id: r.agent_id, session_id: typeof r.session_id === 'string' ? r.session_id : null, ts: r.ts,
      input: Number(r.input) || 0, output: Number(r.output) || 0,
      cache_read: Number(r.cache_read) || 0, cache_creation: Number(r.cache_creation) || 0,
      model: typeof r.model === 'string' && r.model ? r.model : null, usd: Number(r.usd) || 0,
      ...(r.usd_exact === true ? { usd_exact: true } : {})
    };
  } catch {
    return null;
  }
}

/** Pure fold, exported for the tests. */
export function foldPayroll(text: string, clock: FoldClock): PayrollSummary {
  const rows: Row[] = [];
  for (const line of text.split('\n')) { const r = parseRow(line); if (r) rows.push(r); }
  if (!rows.length) {
    return { generatedAt: clock.now, agents: [], floor: emptyWindows(), unknownModels: [], empty: true };
  }
  // Stable sort by ts inside each (agent, session) group; the ledger is
  // append-ordered already, so this only repairs the odd out-of-order write.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.agent_id}\t${r.session_id ?? ''}`;
    const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]);
  }
  const agents = new Map<string, PayrollAgent>();
  const unknown = new Set<string>();
  const floor = emptyWindows();
  const weekStart = clock.now - 7 * DAY;
  const monthStart = clock.now - 30 * DAY;

  const agentOf = (id: string): PayrollAgent => {
    let a = agents.get(id);
    if (!a) {
      a = { agentId: id, model: null, models: [], windows: emptyWindows(), unknownPrice: false, variablePrice: false, claude: false, lastTs: 0 };
      agents.set(id, a);
    }
    return a;
  };

  for (const [key, g] of groups) {
    g.sort((x, y) => x.ts - y.ts);
    const perRequest = key.includes('\tproxy-');
    let prev: Row | null = null;
    for (const r of g) {
      let d: { input: number; output: number; cacheRead: number; cacheWrite: number; usd: number };
      if (perRequest || !prev) {
        d = { input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_creation, usd: r.usd };
      } else {
        const di = r.input - prev.input, dout = r.output - prev.output;
        const dcr = r.cache_read - prev.cache_read, dcw = r.cache_creation - prev.cache_creation, du = r.usd - prev.usd;
        const reset = di < -EPS || dout < -EPS || dcr < -EPS || dcw < -EPS || du < -EPS;
        d = reset
          ? { input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_creation, usd: r.usd }
          : { input: di, output: dout, cacheRead: dcr, cacheWrite: dcw, usd: du };
      }
      prev = r;
      const info = priceInfo(r.model);
      // A row the provider itself priced (OpenRouter's usage accounting, OpenCode's
      // own cost field) is a fact: keep it. Everything else non-Claude is
      // re-priced from tokens with the current table, long-context rule included.
      const exact = r.usd_exact === true;
      if (!info.claude && !exact) {
        d.usd = costFromPrice(info.price, { inputTokens: d.input, outputTokens: d.output, cacheReadTokens: d.cacheRead, cacheWriteTokens: d.cacheWrite });
      }
      const t: PayrollTotals = { ...d, tokens: d.input + d.output + d.cacheRead + d.cacheWrite };
      if (t.tokens <= 0 && t.usd <= 0) continue;
      const a = agentOf(r.agent_id);
      const model = normalizeModel(r.model) || null;
      if (model && !a.models.includes(model)) a.models.unshift(model);
      if (r.ts >= a.lastTs) { a.lastTs = r.ts; if (model) a.model = model; }
      if (!info.known && model) { a.unknownPrice = true; unknown.add(model); }
      if (info.variable && !exact) a.variablePrice = true;
      if (info.claude) a.claude = true;
      const wins: PayrollWindow[] = ['all'];
      if (r.ts >= monthStart) wins.push('month');
      if (r.ts >= weekStart) wins.push('week');
      if (r.ts >= clock.dayStart) wins.push('today');
      for (const w of wins) { addTotals(a.windows[w], t); addTotals(floor[w], t); }
    }
  }
  const list = [...agents.values()].sort((x, y) => y.windows.all.usd - x.windows.all.usd || y.windows.all.tokens - x.windows.all.tokens);
  return { generatedAt: clock.now, agents: list, floor, unknownModels: [...unknown].sort(), empty: false };
}

export function localDayStart(now: number): number {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
}

/** Reads the ledger on demand and caches the fold while the file is unchanged. */
export class PayrollService {
  private cacheKey = '';
  private cached: PayrollSummary | null = null;
  private inflight: Promise<PayrollSummary> | null = null;

  constructor(private readonly ledgerPath: () => string | null) {}

  invalidate(): void { this.cacheKey = ''; }

  async summary(now: number = Date.now()): Promise<PayrollSummary> {
    const p = this.ledgerPath();
    const clock = { now, dayStart: localDayStart(now) };
    if (!p) return { generatedAt: now, agents: [], floor: emptyWindows(), unknownModels: [], empty: true };
    let key = '';
    try { const st = await stat(p); key = `${st.size}:${Math.floor(st.mtimeMs)}:${clock.dayStart}`; } catch { return { generatedAt: now, agents: [], floor: emptyWindows(), unknownModels: [], empty: true }; }
    // The windows roll with the clock even when the file does not: refresh at
    // least once a minute so "today" cannot go stale across midnight.
    if (this.cached && key === this.cacheKey && now - this.cached.generatedAt < 60_000) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const text = await readFile(p, 'utf8');
        const out = foldPayroll(text, clock);
        this.cached = out; this.cacheKey = key;
        return out;
      } catch {
        return this.cached ?? { generatedAt: now, agents: [], floor: emptyWindows(), unknownModels: [], empty: true };
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

export { zeroTotals };
