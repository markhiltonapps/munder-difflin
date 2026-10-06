/**
 * Payroll — renderer state. One summary shared by the sidebar lines, the
 * classic cards, the Payroll tab and the voice tool. Polled once a minute
 * while anything is subscribed; the fold itself is cheap and cached in main.
 */
import { useSyncExternalStore } from 'react';
import { fmtTokens, fmtUsd, shortModelLabel, type PayrollAgent, type PayrollSummary } from '@shared/payroll';
import { providerReportsUsage, type AgentProvider } from '@shared/agentProvider';

interface State { summary: PayrollSummary | null; loaded: boolean }

let state: State = { summary: null, loaded: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function emit(next: State): void { state = next; for (const l of listeners) l(); }

export function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const s = await window.cth.payrollSummary?.();
      if (s) emit({ summary: s, loaded: true });
    } catch { /* keep the last summary */ } finally { inflight = null; }
  })();
  return inflight;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) { timer = setInterval(() => { void refresh(); }, 60_000); void refresh(); }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; }
  };
}
const snap = (): State => state;

export function usePayroll(): State { return useSyncExternalStore(subscribe, snap, snap); }

export function agentPayroll(id: string): PayrollAgent | null {
  return state.summary?.agents.find((a) => a.agentId === id) ?? null;
}

export interface PayrollLabels {
  today: string; week: string; month: string; all: string;
  apiEq: string; unknown: string; notMetered: string; noUsageYet: string;
  /** "cached re-reads" — the share of tokens that were the model re-reading
   *  its own context from cache (a tool-heavy session is mostly this). */
  cached?: string;
  /** Some usage priced from a per-call-varying table row (an estimate). */
  variable?: string;
}

/** What the roster says the agent runs on. The ledger only knows the model of
 *  the last sample that REACHED it, so after a switch to an engine that does
 *  not report usage the ledger would keep naming the old one. */
export interface ConfiguredEngine { model?: string | null; provider?: AgentProvider }

/** The one-line summary under an agent's name, and the fuller hover text. */
export function payrollLineFor(a: PayrollAgent | null, labels: PayrollLabels, configured: ConfiguredEngine = {}): { line: string; title: string } | null {
  const label = shortModelLabel(configured.model || a?.model || null);
  const metered = providerReportsUsage(configured.provider);
  if (!metered) {
    return { line: `${label} · ${labels.notMetered}`, title: labels.notMetered };
  }
  if (!a) {
    if (!configured.model) return null;
    return { line: `${label} · ${labels.noUsageYet}`, title: labels.noUsageYet };
  }
  const t = a.windows.today;
  const line = `${label} · ${fmtTokens(t.tokens)} tok · ${fmtUsd(t.usd)} ${labels.today}`;
  const rows = (['today', 'week', 'month', 'all'] as const).map((w) => `${labels[w]}: ${fmtTokens(a.windows[w].tokens)} tokens, ${fmtUsd(a.windows[w].usd)}`);
  // Where a big token count comes from: every request re-sends the whole
  // context, mostly as cheap cache reads. Saying so stops "13M tokens for two
  // questions" from reading like a fault.
  if (labels.cached && t.tokens > 0 && t.cacheRead > 0) {
    rows.push(`${labels.cached}: ${fmtTokens(t.cacheRead)} (${Math.round((t.cacheRead / t.tokens) * 100)}%) ${labels.today}`);
  }
  const notes = [a.claude ? labels.apiEq : '', a.unknownPrice ? labels.unknown : '', a.variablePrice && labels.variable ? labels.variable : ''].filter(Boolean);
  return { line, title: [...rows, ...notes].join('\n') };
}

export function usePayrollLine(id: string, labels: PayrollLabels, configured: ConfiguredEngine = {}): { line: string; title: string } | null {
  const st = usePayroll();
  if (!st.loaded) return null;
  return payrollLineFor(st.summary?.agents.find((a) => a.agentId === id) ?? null, labels, configured);
}

export const payroll = { refresh, agentPayroll };
