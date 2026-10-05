import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { payroll, usePayroll } from '@/payroll/store';
import { PAYROLL_WINDOWS, fmtTokens, fmtUsd, payrollCsv, shortModelLabel, type PayrollAgent, type PayrollWindow } from '@shared/payroll';

/**
 * PAYROLL — who is on the floor, what they run on, and what they cost.
 *
 * One row per agent with tokens and dollars for today, the last 7 days, the
 * last 30 days and all time, sortable by any column, with the floor total at
 * the bottom. Claude agents on a subscription show an API-equivalent figure
 * (what the same work would have cost at list price), marked as such; it is
 * the right number for comparing engines, not a bill. A model with no price
 * on file is flagged and counted at zero so the total is never inflated.
 */

const head: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
};
const th: CSSProperties = {
  ...head, textAlign: 'end', padding: '6px 8px', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
  borderBottom: '1px solid var(--cth-ink-300)', position: 'sticky', top: 0, background: 'var(--cth-paper-200)'
};
const td: CSSProperties = { padding: '6px 8px', textAlign: 'end', fontSize: 12, whiteSpace: 'nowrap', fontFamily: 'var(--cth-font-mono)' };

type SortKey = 'name' | 'model' | `${PayrollWindow}-tokens` | `${PayrollWindow}-usd`;

export function PayrollTab() {
  const { t } = useTranslation();
  const st = usePayroll();
  const agents = useStore((s) => s.agents);
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;
  const [sort, setSort] = useState<SortKey>('month-usd');
  const [desc, setDesc] = useState(true);
  const [note, setNote] = useState('');

  const rows = useMemo(() => {
    const list = [...(st.summary?.agents ?? [])];
    const val = (a: PayrollAgent): string | number => {
      if (sort === 'name') return nameOf(a.agentId).toLowerCase();
      if (sort === 'model') return a.model ?? '';
      const [w, k] = sort.split('-') as [PayrollWindow, 'tokens' | 'usd'];
      return a.windows[w][k];
    };
    list.sort((x, y) => {
      const a = val(x), b = val(y);
      const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
      return desc ? -c : c;
    });
    return list;
  }, [st.summary, sort, desc, agents]);

  const clickSort = (k: SortKey) => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(k !== 'name' && k !== 'model'); } };
  const arrow = (k: SortKey) => (sort === k ? (desc ? ' ▾' : ' ▴') : '');

  const exportCsv = () => {
    if (!st.summary) return;
    try {
      const blob = new Blob([payrollCsv(st.summary, nameOf)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `payroll-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setNote(t('payroll.exported'));
    } catch { setNote(t('payroll.exportFailed')); }
    setTimeout(() => setNote(''), 2500);
  };

  const wl: Record<PayrollWindow, string> = { today: t('payroll.today'), week: t('payroll.week'), month: t('payroll.month'), all: t('payroll.all') };
  const floor = st.summary?.floor;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--cth-ink-300)', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={head}>{t('payroll.title')}</span>
        {floor && (
          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
            {t('payroll.floorLine', { today: fmtUsd(floor.today.usd), month: fmtUsd(floor.month.usd), all: fmtUsd(floor.all.usd) })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {note && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</span>}
        <PixelButton variant="secondary" size="sm" onClick={() => { void payroll.refresh(); }}>{t('payroll.refresh')}</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={exportCsv} disabled={!st.summary || st.summary.empty}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="ledger" /> {t('payroll.exportCsv')}</span>
        </PixelButton>
      </div>

      {st.loaded && (!st.summary || st.summary.empty) ? (
        <div style={{ padding: 24, maxWidth: 560, fontSize: 13, lineHeight: '19px', color: 'var(--cth-ink-900)' }}>
          <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, marginBottom: 8 }}>{t('payroll.emptyTitle')}</div>
          {t('payroll.emptyBody')}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'start' }} onClick={() => clickSort('name')}>{t('payroll.agent')}{arrow('name')}</th>
                <th style={{ ...th, textAlign: 'start' }} onClick={() => clickSort('model')}>{t('payroll.model')}{arrow('model')}</th>
                {PAYROLL_WINDOWS.map((w) => (
                  <th key={w} colSpan={2} style={{ ...th, textAlign: 'center', borderInlineStart: '1px solid var(--cth-ink-300)' }}>{wl[w]}</th>
                ))}
              </tr>
              <tr>
                <th style={th} />
                <th style={th} />
                {PAYROLL_WINDOWS.map((w) => (
                  <>
                    <th key={`${w}-t`} style={{ ...th, borderInlineStart: '1px solid var(--cth-ink-300)' }} onClick={() => clickSort(`${w}-tokens`)}>{t('payroll.tokens')}{arrow(`${w}-tokens`)}</th>
                    <th key={`${w}-u`} style={th} onClick={() => clickSort(`${w}-usd`)}>{t('payroll.cost')}{arrow(`${w}-usd`)}</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.agentId} style={{ borderBottom: '1px solid var(--cth-ink-300)' }}>
                  <td style={{ ...td, textAlign: 'start', fontFamily: 'var(--cth-font-ui)', fontSize: 13 }} title={a.agentId}>
                    {nameOf(a.agentId)}
                    {a.claude && <span title={t('payroll.apiEquivalent')} style={{ marginInlineStart: 6, fontSize: 10, color: 'var(--cth-ink-500)' }}>{t('payroll.apiEqTag')}</span>}
                    {a.unknownPrice && <span title={t('payroll.unknownPrice')} style={{ marginInlineStart: 6, fontSize: 10, color: '#6E1423' }}>{t('payroll.unknownTag')}</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'start' }} title={a.models.join('\n')}>{shortModelLabel(a.model)}{a.models.length > 1 ? ` +${a.models.length - 1}` : ''}</td>
                  {PAYROLL_WINDOWS.map((w) => (
                    <>
                      <td key={`${w}-t`} style={{ ...td, borderInlineStart: '1px solid var(--cth-ink-300)' }} title={`${a.windows[w].input.toLocaleString()} in · ${a.windows[w].output.toLocaleString()} out · ${a.windows[w].cacheRead.toLocaleString()} cache read · ${a.windows[w].cacheWrite.toLocaleString()} cache write`}>
                        {fmtTokens(a.windows[w].tokens)}
                      </td>
                      <td key={`${w}-u`} style={td}>{fmtUsd(a.windows[w].usd)}</td>
                    </>
                  ))}
                </tr>
              ))}
              {floor && (
                <tr style={{ background: 'var(--cth-cream-100)' }}>
                  <td style={{ ...td, textAlign: 'start', fontFamily: 'var(--cth-font-display)', fontSize: 8 }}>{t('payroll.floorTotal')}</td>
                  <td style={td} />
                  {PAYROLL_WINDOWS.map((w) => (
                    <>
                      <td key={`${w}-t`} style={{ ...td, borderInlineStart: '1px solid var(--cth-ink-300)', fontWeight: 600 }}>{fmtTokens(floor[w].tokens)}</td>
                      <td key={`${w}-u`} style={{ ...td, fontWeight: 600 }}>{fmtUsd(floor[w].usd)}</td>
                    </>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
          <div style={{ padding: '8px 10px 14px', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', maxWidth: 820 }}>
            {t('payroll.footnote')}
            {st.summary && st.summary.unknownModels.length > 0 && (
              <div style={{ marginTop: 4 }}>{t('payroll.unknownList', { models: st.summary.unknownModels.join(', ') })}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
