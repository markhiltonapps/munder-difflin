/**
 * Payroll — renderer state. One summary shared by the sidebar lines, the
 * classic cards, the Payroll tab and the voice tool. Polled once a minute
 * while anything is subscribed; the fold itself is cheap and cached in main.
 */
import { useSyncExternalStore } from 'react';
import { fmtTokens, fmtUsd, shortModelLabel, type PayrollAgent, type PayrollSummary } from '@shared/payroll';

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

/** The one-line summary under an agent's name, and the fuller hover text. */
export function payrollLineFor(a: PayrollAgent | null, labels: { today: string; week: string; month: string; all: string; apiEq: string; unknown: string }): { line: string; title: string } | null {
  if (!a) return null;
  const t = a.windows.today;
  const line = `${shortModelLabel(a.model)} · ${fmtTokens(t.tokens)} tok · ${fmtUsd(t.usd)} ${labels.today}`;
  const rows = (['today', 'week', 'month', 'all'] as const).map((w) => `${labels[w]}: ${fmtTokens(a.windows[w].tokens)} tokens, ${fmtUsd(a.windows[w].usd)}`);
  const notes = [a.claude ? labels.apiEq : '', a.unknownPrice ? labels.unknown : ''].filter(Boolean);
  return { line, title: [...rows, ...notes].join('\n') };
}

export function usePayrollLine(id: string, labels: Parameters<typeof payrollLineFor>[1]): { line: string; title: string } | null {
  const st = usePayroll();
  if (!st.loaded) return null;
  return payrollLineFor(st.summary?.agents.find((a) => a.agentId === id) ?? null, labels);
}

export const payroll = { refresh, agentPayroll };
