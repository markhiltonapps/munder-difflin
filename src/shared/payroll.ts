/**
 * Payroll — what each agent has used and what it cost, by time window.
 *
 * The question the owner asks is the one you ask about staff: who is on the
 * floor, what are they on, and what did they cost me today, this week, this
 * month and overall. Shared between main (the fold over cost-ledger.jsonl)
 * and the renderer (the sidebar line, the Payroll tab, the CSV).
 */

export type PayrollWindow = 'today' | 'week' | 'month' | 'all';
export const PAYROLL_WINDOWS: PayrollWindow[] = ['today', 'week', 'month', 'all'];

export interface PayrollTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite */
  tokens: number;
  usd: number;
}

export interface PayrollAgent {
  agentId: string;
  /** The model of the most recent sample, normalized. */
  model: string | null;
  /** Every model this agent has run on, most recent first. */
  models: string[];
  windows: Record<PayrollWindow, PayrollTotals>;
  /** Some of this agent's usage was on a model with no price on file, so the
   *  dollar figure is a floor, not the total. */
  unknownPrice: boolean;
  /** Any usage on a Claude model: that spend is API-equivalent, not a bill,
   *  when the agents run on a subscription. */
  claude: boolean;
  lastTs: number;
}

export interface PayrollSummary {
  generatedAt: number;
  agents: PayrollAgent[];
  floor: Record<PayrollWindow, PayrollTotals>;
  /** Models seen in the ledger with no price on file. */
  unknownModels: string[];
  /** The ledger was not readable (no hive yet, or no samples). */
  empty: boolean;
}

export function zeroTotals(): PayrollTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, usd: 0 };
}

export function emptyWindows(): Record<PayrollWindow, PayrollTotals> {
  return { today: zeroTotals(), week: zeroTotals(), month: zeroTotals(), all: zeroTotals() };
}

export function addTotals(into: PayrollTotals, d: PayrollTotals): void {
  into.input += d.input; into.output += d.output;
  into.cacheRead += d.cacheRead; into.cacheWrite += d.cacheWrite;
  into.tokens += d.tokens; into.usd += d.usd;
}

/** A short human label for a model id: provider prefixes and date stamps go,
 *  the family name stays. `openrouter/deepseek/deepseek-v4-pro-0813` → `deepseek-v4-pro`. */
export function shortModelLabel(model: string | null | undefined): string {
  if (!model) return '—';
  let m = model.trim().replace(/\[[^\]]*\]\s*$/, '');
  const parts = m.split('/');
  m = parts[parts.length - 1] || m;
  m = m.replace(/[-_:]?\d{4}(-?\d{2}){0,2}$/, '').replace(/-?(latest|preview)$/i, '');
  return m || model;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(1)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Comma-separated export of the summary, one row per agent, windows side by side. */
export function payrollCsv(s: PayrollSummary, nameOf: (id: string) => string): string {
  const q = (v: string | number): string => {
    const t = String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ['agent', 'agent_id', 'model', 'claude_api_equivalent', 'price_unknown'];
  for (const w of PAYROLL_WINDOWS) head.push(`${w}_tokens`, `${w}_input`, `${w}_output`, `${w}_cache_read`, `${w}_cache_write`, `${w}_usd`);
  const rows = [head.map(q).join(',')];
  for (const a of s.agents) {
    const r: (string | number)[] = [nameOf(a.agentId), a.agentId, a.model ?? '', a.claude ? 'yes' : 'no', a.unknownPrice ? 'yes' : 'no'];
    for (const w of PAYROLL_WINDOWS) {
      const t = a.windows[w];
      r.push(t.tokens, t.input, t.output, t.cacheRead, t.cacheWrite, t.usd.toFixed(4));
    }
    rows.push(r.map(q).join(','));
  }
  const f: (string | number)[] = ['FLOOR TOTAL', '', '', '', ''];
  for (const w of PAYROLL_WINDOWS) {
    const t = s.floor[w];
    f.push(t.tokens, t.input, t.output, t.cacheRead, t.cacheWrite, t.usd.toFixed(4));
  }
  rows.push(f.map(q).join(','));
  return rows.join('\n') + '\n';
}
