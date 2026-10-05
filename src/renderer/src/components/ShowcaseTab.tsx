import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { useStore } from '@/store/store';
import { showcase, useShowcase, type ShowcaseViewing } from '@/showcase/store';
import { showcaseUrl, type ShowcaseItem } from '@shared/showcase';

/**
 * SHOWCASE — the shelf of things agents made for you to look at.
 *
 * A gallery of every deliverable under <hive>/showcase, newest first, each
 * drawn as it is meant to be seen: a page as a page, a picture as a picture.
 * Click one and it opens full size right here. Unseen items carry a mark
 * until opened. Nothing to copy, no browser to open.
 *
 * Pages render in a sandboxed frame with no scripts, served over the app's
 * own cth-showcase scheme (see src/shared/showcase.ts). "Open outside" hands
 * the file to the default app for the times a page needs its scripts.
 */

const head: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
};

const SANDBOX = '';

function agentLabel(id: string | null, agents: { id: string; name: string }[]): string | null {
  if (!id) return null;
  return agents.find((a) => a.id === id)?.name ?? id;
}

function fmtWhen(ms: number, locale: string): string {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** A live, scaled-down rendering of the deliverable for its card. */
function Thumb({ item }: { item: ShowcaseItem }) {
  const url = showcaseUrl(item.abs);
  const box: CSSProperties = {
    width: '100%', aspectRatio: '4 / 3', overflow: 'hidden', position: 'relative',
    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
  };
  if (item.kind === 'image') {
    return <div style={box}><img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /></div>;
  }
  if (item.kind === 'page') {
    // A real rendering at a quarter scale; pointer-events off so the card takes the click.
    return (
      <div style={box}>
        <iframe
          src={url}
          sandbox={SANDBOX}
          tabIndex={-1}
          title={item.name}
          style={{
            width: '400%', height: '400%', border: 'none', pointerEvents: 'none',
            transform: 'scale(0.25)', transformOrigin: '0 0', background: '#fff'
          }}
        />
      </div>
    );
  }
  return (
    <div style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6, color: 'var(--cth-ink-500)' }}>
      <Icon name={item.kind === 'pdf' ? 'ledger' : 'edit'} />
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8 }}>{item.kind.toUpperCase()}</span>
    </div>
  );
}

function Viewer({ v, onClose }: { v: ShowcaseViewing; onClose: () => void }) {
  const { t } = useTranslation();
  const url = showcaseUrl(v.abs);
  const [md, setMd] = useState<string | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    setMd(null);
    if (v.kind !== 'markdown') return;
    let alive = true;
    fetch(url).then((r) => r.text()).then((txt) => { if (alive) setMd(txt); }).catch(() => { if (alive) setMd(''); });
    return () => { alive = false; };
  }, [url, v.kind]);

  const openOutside = async () => {
    const r = await window.cth.showcaseOpen?.(v.abs).catch(() => ({ ok: false }));
    setNote(r?.ok ? t('showcase.opened') : t('showcase.couldNotOpen'));
    setTimeout(() => setNote(''), 2500);
  };
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(v.abs); setNote(t('showcase.copied')); } catch { setNote(t('showcase.couldNotCopy')); }
    setTimeout(() => setNote(''), 2500);
  };
  const reveal = () => { void window.cth.revealPath(v.abs).catch(() => { /* file browser refused */ }); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--cth-ink-300)', flexShrink: 0, flexWrap: 'wrap' }}>
        <PixelButton variant="secondary" size="sm" onClick={onClose}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="arrow-right" /> {t('showcase.back')}</span>
        </PixelButton>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={v.abs}>
          {v.name}
        </span>
        {note && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</span>}
        <PixelButton variant="secondary" size="sm" onClick={() => { void openOutside(); }} title={t('showcase.openOutsideTip')}>{t('showcase.openOutside')}</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={reveal}>{t('showcase.reveal')}</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => { void copyPath(); }}>{t('showcase.copyPath')}</PixelButton>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: v.kind === 'page' || v.kind === 'pdf' ? '#fff' : 'var(--cth-paper-200)', overflow: 'auto' }}>
        {v.kind === 'page' && (
          <iframe src={url} sandbox={SANDBOX} title={v.name} style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} />
        )}
        {v.kind === 'pdf' && (
          // The PDF viewer is Chromium's own plugin; it does not run inside a sandboxed frame.
          <iframe src={url} title={v.name} style={{ width: '100%', height: '100%', border: 'none' }} />
        )}
        {v.kind === 'image' && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100%', padding: 12, boxSizing: 'border-box' }}>
            <img src={url} alt={v.name} style={{ maxWidth: '100%', maxHeight: '100%', boxShadow: '0 0 0 1px var(--cth-ink-300)' }} />
          </div>
        )}
        {v.kind === 'markdown' && (
          <div style={{ padding: 16, maxWidth: 820 }}>
            {md === null ? <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('showcase.loading')}</span> : <MarkdownPreview source={md} />}
          </div>
        )}
      </div>
    </div>
  );
}

export function ShowcaseTab() {
  const { t, i18n } = useTranslation();
  const st = useShowcase();
  const agents = useStore((s) => s.agents);
  const godName = agents.find((a) => a.isGod)?.name ?? 'Michael';
  const [filter, setFilter] = useState<string>('all');
  const agentIds = useMemo(() => Array.from(new Set(st.items.map((i) => i.agent).filter((a): a is string => !!a))), [st.items]);
  const items = useMemo(() => (filter === 'all' ? st.items : st.items.filter((i) => i.agent === filter)), [st.items, filter]);

  if (st.viewing) return <Viewer v={st.viewing} onClose={showcase.closeViewer} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--cth-ink-300)', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={head}>{t('showcase.title')}</span>
        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
          {st.unseen > 0 ? t('showcase.unseenCount', { count: st.unseen }) : t('showcase.allSeen', { count: st.items.length })}
        </span>
        <span style={{ flex: 1 }} />
        {agentIds.length > 1 && (
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, padding: '2px 6px', background: 'var(--cth-cream-100)', border: '1px solid var(--cth-ink-300)' }}>
            <option value="all">{t('showcase.everyone')}</option>
            {agentIds.map((id) => <option key={id} value={id}>{agentLabel(id, agents)}</option>)}
          </select>
        )}
        <PixelButton variant="secondary" size="sm" onClick={() => { void showcase.refresh(); }}>{t('showcase.refresh')}</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => { void window.cth.revealPath(st.root).catch(() => { /* noop */ }); }} disabled={!st.root}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="folder" /> {t('showcase.folder')}</span>
        </PixelButton>
      </div>

      {st.loaded && items.length === 0 ? (
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560, color: 'var(--cth-ink-900)', fontSize: 13, lineHeight: '19px' }}>
          <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10 }}>{t('showcase.emptyTitle')}</span>
          <span>{t('showcase.emptyBody')}</span>
          <code style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '6px 8px', background: 'var(--cth-cream-100)', wordBreak: 'break-all' }}>{st.root}</code>
          <span style={{ color: 'var(--cth-ink-500)', fontSize: 12 }}>{t('showcase.emptyHint', { godName })}</span>
        </div>
      ) : (
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto', padding: 10,
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, alignContent: 'start'
        }}>
          {items.map((item) => (
            <button
              key={item.rel}
              onClick={() => showcase.openItem(item)}
              title={item.abs}
              style={{
                display: 'flex', flexDirection: 'column', gap: 6, padding: 8, textAlign: 'start',
                background: 'var(--cth-paper-100)', border: 'none', cursor: 'pointer',
                boxShadow: item.unseen ? 'inset 0 0 0 2px var(--cth-coral)' : 'inset 0 0 0 1px var(--cth-ink-300)',
                color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)'
              }}
            >
              <Thumb item={item} />
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                {item.unseen && <span style={{ flexShrink: 0, width: 8, height: 8, background: 'var(--cth-coral)' }} title={t('showcase.new')} />}
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>
              </span>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', display: 'flex', gap: 6, minWidth: 0 }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agentLabel(item.agent, agents) ?? t('showcase.noAgent')}</span>
                <span>·</span>
                <span style={{ whiteSpace: 'nowrap' }}>{fmtWhen(item.mtimeMs, i18n.language)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
