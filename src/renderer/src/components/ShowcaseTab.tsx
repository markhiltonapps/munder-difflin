import { useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { useStore } from '@/store/store';
import { showcase, useShowcase, type ShowcaseViewing } from '@/showcase/store';
import {
  SHOWCASE_GROUP_MODES, groupItems, matchesSearch, showcaseUrl, slugProject,
  type ShowcaseGroupBy, type ShowcaseItem
} from '@shared/showcase';

/**
 * SHOWCASE — the shelf of things agents made for you to look at.
 *
 * Files live as `showcase/<agent>/<project>/<file>`; the shelf shows them
 * grouped by employee, project, date or type, searchable, with the ones you
 * have not opened marked. Click a card and it opens full size right here.
 * "Move to" files a deliverable under a project (the file really moves, with
 * a page's pictures and styles), dragging a card onto a project section does
 * the same, and "Done" puts it away under .archive/ where it stays searchable.
 *
 * Pages render in a sandboxed frame with no scripts, served over the app's
 * own cth-showcase scheme (see src/shared/showcase.ts).
 */

const head: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
};
const control: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, padding: '3px 6px',
  background: 'var(--cth-cream-100)', border: '1px solid var(--cth-ink-300)', color: 'var(--cth-ink-900)'
};
const SANDBOX = '';
const LS_GROUP = 'cth.showcase.groupBy';

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

/** "Move to…" as a select: existing projects, unsorted, new project. */
function MoveTo({ projects, current, onPick, compact }: { projects: string[]; current: string | null; onPick: (project: string | null) => void; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <select
      value=""
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        if (v === '__new__') {
          const name = window.prompt(t('showcase.newProjectPrompt'));
          const slug = name ? slugProject(name) : null;
          if (slug) onPick(slug);
          return;
        }
        onPick(v === '__unsorted__' ? null : v);
      }}
      onClick={(e) => e.stopPropagation()}
      title={t('showcase.moveToTip')}
      style={{ ...control, padding: compact ? '1px 4px' : control.padding, fontSize: compact ? 11 : 12 }}
    >
      <option value="">{t('showcase.moveTo')}</option>
      {projects.filter((p) => p !== current).map((p) => <option key={p} value={p}>{p}</option>)}
      {current !== null && <option value="__unsorted__">{t('showcase.unsorted')}</option>}
      <option value="__new__">{t('showcase.newProject')}</option>
    </select>
  );
}

function Viewer({ v, item, projects, onClose }: { v: ShowcaseViewing; item: ShowcaseItem | null; projects: string[]; onClose: () => void }) {
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
  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(''), 2500); };

  const openOutside = async () => {
    const r = await window.cth.showcaseOpen?.(v.abs).catch(() => ({ ok: false }));
    flash(r?.ok ? t('showcase.opened') : t('showcase.couldNotOpen'));
  };
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(v.abs); flash(t('showcase.copied')); } catch { flash(t('showcase.couldNotCopy')); }
  };
  const reveal = () => { void window.cth.revealPath(v.abs).catch(() => { /* file browser refused */ }); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--cth-ink-300)', flexShrink: 0, flexWrap: 'wrap' }}>
        <PixelButton variant="secondary" size="sm" onClick={onClose}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="arrow-right" /> {t('showcase.back')}</span>
        </PixelButton>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={v.abs}>
          {v.name}{item?.project ? <span style={{ color: 'var(--cth-ink-500)' }}> · {item.project}</span> : null}
        </span>
        {note && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</span>}
        {item && (
          <MoveTo projects={projects} current={item.project} onPick={(p) => { void showcase.moveItem(item.rel, p).then((r) => { if (!r.ok) flash(r.error ?? t('showcase.couldNotMove')); }); }} />
        )}
        {item && (
          <PixelButton variant={item.archived ? 'secondary' : 'primary'} size="sm" onClick={() => { void showcase.setArchived(item.rel, !item.archived); }}>
            {item.archived ? t('showcase.restore') : t('showcase.done')}
          </PixelButton>
        )}
        <PixelButton variant="secondary" size="sm" onClick={() => { void openOutside(); }} title={t('showcase.openOutsideTip')}>{t('showcase.openOutside')}</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={reveal}>{t('showcase.reveal')}</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => { void copyPath(); }}>{t('showcase.copyPath')}</PixelButton>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: v.kind === 'page' || v.kind === 'pdf' ? '#fff' : 'var(--cth-paper-200)', overflow: 'auto' }}>
        {v.kind === 'page' && (
          <iframe src={url} sandbox={SANDBOX} title={v.name} style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} />
        )}
        {v.kind === 'pdf' && (
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

function readGroupBy(): ShowcaseGroupBy {
  try {
    const v = localStorage.getItem(LS_GROUP);
    return (SHOWCASE_GROUP_MODES as string[]).includes(v ?? '') ? (v as ShowcaseGroupBy) : 'employee';
  } catch { return 'employee'; }
}

export function ShowcaseTab() {
  const { t, i18n } = useTranslation();
  const st = useShowcase();
  const agents = useStore((s) => s.agents);
  const godName = agents.find((a) => a.isGod)?.name ?? 'Michael';
  const [groupBy, setGroupBy] = useState<ShowcaseGroupBy>(readGroupBy);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [dropKey, setDropKey] = useState<string | null>(null);
  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(''), 2500); };

  const pickGroup = (g: ShowcaseGroupBy) => { setGroupBy(g); try { localStorage.setItem(LS_GROUP, g); } catch { /* fine */ } };

  const projects = useMemo(() => Array.from(new Set(st.items.map((i) => i.project).filter((p): p is string => !!p))).sort(), [st.items]);
  const visible = useMemo(
    () => st.items.filter((i) => i.archived === showArchived && matchesSearch(i, query)),
    [st.items, showArchived, query]
  );
  const groups = useMemo(() => groupItems(visible, groupBy), [visible, groupBy]);
  const byRel = useMemo(() => new Map(st.items.map((i) => [i.rel, i] as const)), [st.items]);

  // Selection is pruned to what still exists.
  useEffect(() => {
    setSelected((prev) => { const next = new Set([...prev].filter((r) => byRel.has(r))); return next.size === prev.size ? prev : next; });
  }, [byRel]);

  const groupLabel = (key: string): string => {
    if (groupBy === 'employee') return key ? (agentLabel(key, agents) ?? key) : t('showcase.noAgent');
    if (groupBy === 'project') return key || t('showcase.unsorted');
    if (groupBy === 'date') return t(`showcase.dates.${key}`);
    return t(`showcase.kinds.${key}`);
  };

  const onCardClick = (e: React.MouseEvent, item: ShowcaseItem) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      setSelected((prev) => { const n = new Set(prev); if (n.has(item.rel)) n.delete(item.rel); else n.add(item.rel); return n; });
      return;
    }
    setSelected(new Set());
    showcase.openItem(item);
  };

  const act = async (rels: string[], fn: (rel: string) => Promise<{ ok: boolean; error?: string }>) => {
    let failed = 0;
    for (const r of rels) { const res = await fn(r); if (!res.ok) failed += 1; }
    setSelected(new Set());
    if (failed) flash(t('showcase.someFailed', { count: failed }));
  };
  const moveMany = (rels: string[], project: string | null) => act(rels, (r) => showcase.moveItem(r, project));
  const archiveMany = (rels: string[], archived: boolean) => act(rels, (r) => showcase.setArchived(r, archived));

  // Drag a card onto a project section header (when grouped by project).
  const onDragStart = (e: DragEvent, item: ShowcaseItem) => {
    const rels = selected.has(item.rel) ? [...selected] : [item.rel];
    e.dataTransfer.setData('text/x-showcase-rels', JSON.stringify(rels));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDropOnGroup = (e: DragEvent, key: string) => {
    e.preventDefault(); setDropKey(null);
    let rels: string[] = [];
    try { rels = JSON.parse(e.dataTransfer.getData('text/x-showcase-rels')) as string[]; } catch { return; }
    if (!rels.length) return;
    void moveMany(rels, key || null);
  };

  if (st.viewing) {
    return <Viewer v={st.viewing} item={st.viewing.rel ? byRel.get(st.viewing.rel) ?? null : null} projects={projects} onClose={showcase.closeViewer} />;
  }

  const archivedCount = st.items.filter((i) => i.archived).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--cth-ink-300)', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={head}>{t('showcase.title')}</span>
        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
          {st.unseen > 0 ? t('showcase.unseenCount', { count: st.unseen }) : t('showcase.allSeen', { count: st.items.filter((i) => !i.archived).length })}
        </span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--cth-ink-500)' }}>
          {t('showcase.groupBy')}
          <select value={groupBy} onChange={(e) => pickGroup(e.target.value as ShowcaseGroupBy)} style={control}>
            {SHOWCASE_GROUP_MODES.map((g) => <option key={g} value={g}>{t(`showcase.groups.${g}`)}</option>)}
          </select>
        </label>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('showcase.searchPlaceholder')}
          style={{ ...control, width: 180 }}
        />
        <button
          onClick={() => setShowArchived(!showArchived)}
          style={{ ...control, cursor: 'pointer', background: showArchived ? 'var(--cth-lemon)' : control.background }}
          title={t('showcase.archivedTip')}
        >{t('showcase.archived', { count: archivedCount })}</button>
        <span style={{ flex: 1 }} />
        {note && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</span>}
        <PixelButton variant="secondary" size="sm" onClick={() => { void showcase.refresh(); }}>{t('showcase.refresh')}</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => { void window.cth.revealPath(st.root).catch(() => { /* noop */ }); }} disabled={!st.root}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="folder" /> {t('showcase.folder')}</span>
        </PixelButton>
      </div>

      {selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--cth-cream-100)', borderBottom: '1px solid var(--cth-ink-300)', flexShrink: 0, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12 }}>{t('showcase.selectedCount', { count: selected.size })}</span>
          <MoveTo projects={projects} current={null} onPick={(p) => { void moveMany([...selected], p); }} />
          <PixelButton variant="primary" size="sm" onClick={() => { void archiveMany([...selected], !showArchived); }}>
            {showArchived ? t('showcase.restore') : t('showcase.done')}
          </PixelButton>
          <PixelButton variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t('showcase.clearSelection')}</PixelButton>
        </div>
      )}

      {st.loaded && visible.length === 0 ? (
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560, color: 'var(--cth-ink-900)', fontSize: 13, lineHeight: '19px' }}>
          {query || showArchived ? (
            <span>{t('showcase.noMatches')}</span>
          ) : (
            <>
              <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10 }}>{t('showcase.emptyTitle')}</span>
              <span>{t('showcase.emptyBody')}</span>
              <code style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '6px 8px', background: 'var(--cth-cream-100)', wordBreak: 'break-all' }}>{st.root}</code>
              <span style={{ color: 'var(--cth-ink-500)', fontSize: 12 }}>{t('showcase.emptyHint', { godName })}</span>
            </>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groups.map((g) => (
            <section
              key={g.key || '__none__'}
              onDragOver={groupBy === 'project' ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropKey(g.key); } : undefined}
              onDragLeave={groupBy === 'project' ? () => setDropKey((k) => (k === g.key ? null : k)) : undefined}
              onDrop={groupBy === 'project' ? (e) => onDropOnGroup(e, g.key) : undefined}
              style={{ outline: dropKey === g.key ? '2px dashed var(--cth-ink-900)' : 'none', outlineOffset: 4 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '14px', color: 'var(--cth-ink-900)' }}>{groupLabel(g.key).toUpperCase()}</span>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{g.items.length}</span>
                {g.unseen > 0 && (
                  <span style={{ minWidth: 18, height: 16, padding: '0 5px', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--cth-coral)', color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-display)', fontSize: 8 }}>{g.unseen}</span>
                )}
                {groupBy === 'project' && g.key === '' && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('showcase.unsortedHint')}</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, alignContent: 'start' }}>
                {g.items.map((item) => {
                  const isSel = selected.has(item.rel);
                  return (
                    <div
                      key={item.rel}
                      role="button"
                      tabIndex={0}
                      draggable
                      onDragStart={(e) => onDragStart(e, item)}
                      onClick={(e) => onCardClick(e, item)}
                      onKeyDown={(e) => { if (e.key === 'Enter') showcase.openItem(item); }}
                      title={`${item.abs}\n${t('showcase.selectTip')}`}
                      style={{
                        display: 'flex', flexDirection: 'column', gap: 6, padding: 8, textAlign: 'start', cursor: 'pointer',
                        background: isSel ? 'var(--cth-cream-100)' : 'var(--cth-paper-100)',
                        boxShadow: isSel ? 'inset 0 0 0 2px var(--cth-ink-900)' : item.unseen ? 'inset 0 0 0 2px var(--cth-coral)' : 'inset 0 0 0 1px var(--cth-ink-300)',
                        color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)', opacity: item.archived ? 0.75 : 1
                      }}
                    >
                      <Thumb item={item} />
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        {item.unseen && <span style={{ flexShrink: 0, width: 8, height: 8, background: 'var(--cth-coral)' }} title={t('showcase.new')} />}
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', display: 'flex', gap: 6, minWidth: 0 }}>
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {groupBy === 'employee' ? (item.project ?? t('showcase.unsorted')) : (agentLabel(item.agent, agents) ?? t('showcase.noAgent'))}
                        </span>
                        <span>·</span>
                        <span style={{ whiteSpace: 'nowrap' }}>{fmtWhen(item.mtimeMs, i18n.language)}</span>
                      </span>
                      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                        {item.agent && <MoveTo compact projects={projects} current={item.project} onPick={(p) => { void moveMany([item.rel], p); }} />}
                        <button
                          onClick={() => { void archiveMany([item.rel], !item.archived); }}
                          style={{ ...control, padding: '1px 6px', fontSize: 11, cursor: 'pointer' }}
                          title={item.archived ? t('showcase.restoreTip') : t('showcase.doneTip')}
                        >{item.archived ? t('showcase.restore') : t('showcase.done')}</button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
