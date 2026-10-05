import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { Icon, type IconName } from './Icon';
import { useShowcase } from '@/showcase/store';
import { SpritePortrait } from './SpritePortrait';
import { useHasTerminalDraft } from './terminalPool';
import { groupByRepo, useResolvedRepoNames } from './repoGroups';
import {
  asksByAgent, doingByAgent, liveLineFor, matchesSidebarQuery, type SidebarTask
} from './sidebarAsks';
import { useStore, type Agent } from '@/store/store';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useRtl } from '@/i18n/useDirection';
import { useStapler } from '@/stapler/session';
import type { HarnessConfig } from '@/store/config';

/**
 * The office sidebar — the 'sidebar' layout's left rail.
 *
 * Top: the floor-wide surfaces (Tasks, Inbox, Automations, Memory,
 * Capabilities). Each is a Command Center tab that already exists; the rail
 * just puts them one click away instead of behind "select Michael, then find
 * the tab". Clicking one selects the orchestrator and asks the Command Center
 * to open that tab (the same `requestCommandCenterTab` the office floor's
 * props use), so nothing here owns any panel state.
 *
 * Below: every agent, the orchestrator first, everyone else grouped under the
 * repository they are checked out in (the identity the focus-mode roster
 * uses, via repoGroups). A row carries the status badge, a LIVE LINE (what the
 * agent is doing, else the last thing it said), an "asked you" chip when a
 * hive task it owns is waiting on the human, the doing-count sticky, and the
 * private note as bullets. Rows drag to reorder — the same persisted order as
 * the floor strip, so switching layouts never reshuffles anyone.
 *
 * The search box filters rows by name, project, job and note text: the notes
 * are searchable, which is the point of writing them on the agent.
 */

/** Command Center tabs the rail links to, in rail order. */
const SURFACES: { key: string; labelKey: string; icon: IconName }[] = [
  { key: 'showcase', labelKey: 'officeSidebar.showcase',     icon: 'image' },
  { key: 'stapler',  labelKey: 'officeSidebar.stapler',      icon: 'mic' },
  { key: 'tasks',    labelKey: 'officeSidebar.tasks',        icon: 'check' },
  { key: 'human',    labelKey: 'officeSidebar.inbox',        icon: 'bell' },
  { key: 'triggers', labelKey: 'officeSidebar.automations',  icon: 'clock' },
  { key: 'memory',   labelKey: 'officeSidebar.memory',       icon: 'sparkle' },
  { key: 'skills',   labelKey: 'officeSidebar.capabilities', icon: 'mcp' }
];

const POLL_MS = 5000;

export interface OfficeSidebarProps {
  /** Same role as in AgentStrip: rebuilds a spawn command for a restorable
   *  agent saved before the `command` field existed. */
  config?: HarnessConfig | null;
}

export function OfficeSidebar({ config }: OfficeSidebarProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const reorderAgents = useStore(s => s.reorderAgents);
  const setAgentNote = useStore(s => s.setAgentNote);
  const requestCommandCenterTab = useStore(s => s.requestCommandCenterTab);
  const openTaskDetail = useStore(s => s.openTaskDetail);
  const compact = useStore(s => s.officeSidebarCompact);
  const setCompact = useStore(s => s.setOfficeSidebarCompact);
  const { restoring, autoRestoring, restoreTeam } = useRestoreTeam(config);
  const restoreBusy = restoring || autoRestoring;
  const god = agents.find(a => a.isGod);
  // A meeting being recorded shows on the Stapler row wherever you are.
  const staplerRecording = useStapler().status === 'recording';
  const showcaseUnseen = useShowcase().unseen;

  // Hive tasks, polled like the floor strip does: the "asked you" chips and
  // the doing-count stickies come from tasks.json, not from the agent record.
  const [tasks, setTasks] = useState<SidebarTask[]>([]);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const raw = await window.cth.hiveTasks() as { tasks?: SidebarTask[] } | null;
        if (cancelled) return;
        setTasks(raw && Array.isArray(raw.tasks) ? raw.tasks.filter(Boolean) : []);
      } catch { /* keep last good */ }
    };
    void poll();
    const iv = setInterval(() => { void poll(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);
  const asks = useMemo(() => asksByAgent(tasks, god?.id), [tasks, god?.id]);
  const doing = useMemo(() => doingByAgent(tasks), [tasks]);
  const totalAsks = useMemo(() => Object.values(asks).reduce((n, c) => n + c, 0), [asks]);

  // Search filters the roster; grouping is applied to what survives so an
  // empty group simply disappears rather than showing a bare header.
  const [query, setQuery] = useState('');
  const repoVersion = useResolvedRepoNames(agents);
  const { gods, groups } = useMemo(() => {
    const visible = agents.filter(a => matchesSidebarQuery(a, query));
    return groupByRepo(visible);
    // repoVersion: rebucket once the async main-repo lookups land.
  }, [agents, query, repoVersion]);
  const nothingMatches = query.trim() !== '' && gods.length === 0 && groups.length === 0;

  // Which surface is lit. Local because the Command Center owns its own tab
  // state; this is the rail's memory of what IT last opened, and it goes dark
  // the moment the selection moves off the orchestrator (the panel showing
  // then is not the Command Center at all).
  const [surface, setSurface] = useState<string | null>(null);
  useEffect(() => {
    if (!god || selectedId !== god.id) setSurface(null);
  }, [selectedId, god]);
  const openSurface = (key: string) => {
    if (!god) return;
    select(god.id);
    requestCommandCenterTab(key);
    setSurface(key);
  };

  // Drag-to-reorder, same wiring as the floor strip. Off while searching: a
  // filtered list hides neighbours, so a drop would land somewhere unseen.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragEnabled = query.trim() === '';
  const drag: RowDrag = {
    enabled: dragEnabled,
    dragId, overId,
    start: (id) => setDragId(id),
    over: (id) => { if (dragId && dragId !== id && overId !== id) setOverId(id); },
    leave: (id) => { if (overId === id) setOverId(null); },
    drop: (id) => {
      if (dragId && dragId !== id) reorderAgents(dragId, id);
      setDragId(null); setOverId(null);
    },
    end: () => { setDragId(null); setOverId(null); }
  };

  // Note editor: a fixed popover beside the row (the rail clips overflow and a
  // row has no room for a textarea). ✎ opens it; Esc / ✕ / click-away closes.
  const [noteEdit, setNoteEdit] = useState<{ id: string; left: number; top: number } | null>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const NOTE_W = 280;
  const openNoteEditor = (id: string) => {
    if (noteEdit?.id === id) { setNoteEdit(null); return; }
    const rect = rowRefs.current[id]?.getBoundingClientRect();
    if (!rect) return;
    // Opens on the side AWAY from the floor's edge... which is the floor side:
    // the rail hugs the window edge, so the only room is toward the floor.
    const left = rtl
      ? Math.max(8, rect.left - NOTE_W - 6)
      : Math.min(rect.right + 6, window.innerWidth - NOTE_W - 8);
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 150));
    setNoteEdit({ id, left, top });
  };
  const editingAgent = noteEdit ? agents.find(a => a.id === noteEdit.id) : undefined;
  useEffect(() => { if (noteEdit && !editingAgent) setNoteEdit(null); }, [noteEdit, editingAgent]);

  const rowProps = (a: Agent) => ({
    agent: a,
    active: a.id === selectedId,
    compact,
    asks: asks[a.id] ?? 0,
    doingCount: doing[a.id]?.length ?? 0,
    drag,
    rowRef: (el: HTMLButtonElement | null) => { rowRefs.current[a.id] = el; },
    onClick: () => { select(a.id); setSurface(null); },
    onAskClick: () => openSurface('human'),
    onDoingClick: () => { const first = doing[a.id]?.[0]; if (first) openTaskDetail(first); },
    onEditNote: a.isGod ? undefined : () => openNoteEditor(a.id)
  });

  return (
    <aside
      className="cth-titlebar-nodrag"
      style={{
        height: '100%', minHeight: 0,
        display: 'flex', flexDirection: 'column',
        background: 'var(--cth-cream-200)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}
    >
      {/* Header: the rail's name and the one setting that reshapes it. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 10px 6px', flexShrink: 0
      }}>
        <span style={{
          flex: 1, minWidth: 0,
          fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '14px',
          color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>{t('officeSidebar.title')}</span>
        <button
          onClick={() => setCompact(!compact)}
          className="cth-tip cth-tip-wrap"
          data-tip={compact ? t('officeSidebar.showEverything') : t('officeSidebar.agentsAndNotesOnly')}
          aria-label={compact ? t('officeSidebar.showEverything') : t('officeSidebar.agentsAndNotesOnly')}
          aria-pressed={compact}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, padding: 0, border: 'none', cursor: 'pointer',
            background: compact ? 'var(--cth-lemon)' : 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            color: 'var(--cth-ink-900)'
          }}
        >
          <Icon name="sidebar" />
        </button>
      </div>

      {/* Search: names, projects, jobs and the notes you wrote on the rows. */}
      <div style={{ padding: '0 10px 8px', flexShrink: 0 }}>
        <input
          className="cth-input"
          dir={rtl ? 'auto' : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          placeholder={t('officeSidebar.searchPlaceholder')}
          aria-label={t('officeSidebar.searchAria')}
          style={{
            width: '100%', height: 26, padding: '0 8px', boxSizing: 'border-box',
            border: 'none', outline: 'none',
            background: 'var(--cth-cream-100)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
          }}
        />
      </div>

      {/* Surfaces. Hidden in compact mode — "agents and notes only". */}
      {!compact && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 2,
          padding: '0 6px 8px', flexShrink: 0,
          borderBottom: '1px solid var(--cth-ink-300)'
        }}>
          {SURFACES.map((s) => {
            const lit = surface === s.key && !!god && selectedId === god.id;
            const count = s.key === 'human' ? totalAsks : s.key === 'showcase' ? showcaseUnseen : 0;
            return (
              <button
                key={s.key}
                onClick={() => openSurface(s.key)}
                disabled={!god}
                title={god ? undefined : t('officeSidebar.noOrchestrator')}
                aria-current={lit ? 'page' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  height: 28, padding: '0 8px', border: 'none',
                  cursor: god ? 'pointer' : 'default',
                  background: lit ? 'var(--cth-cream-100)' : 'transparent',
                  boxShadow: lit ? 'inset 0 0 0 1px var(--cth-ink-300)' : 'none',
                  color: god ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13, textAlign: 'start'
                }}
              >
                <span style={{ display: 'inline-flex', flexShrink: 0, opacity: god ? 1 : 0.5 }}>
                  <Icon name={s.icon} />
                </span>
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t(s.labelKey)}
                </span>
                {s.key === 'stapler' && staplerRecording && (
                  <span
                    title={t('officeSidebar.recording')}
                    style={{
                      flexShrink: 0, height: 16, padding: '0 5px', boxSizing: 'border-box',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      background: 'var(--cth-coral)', color: 'var(--cth-ink-900)',
                      fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '12px'
                    }}
                  >{t('officeSidebar.rec')}</span>
                )}
                {count > 0 && (
                  <span
                    title={s.key === 'showcase' ? t('officeSidebar.newWork', { count }) : t('officeSidebar.waitingOnYou', { count })}
                    style={{
                      flexShrink: 0, minWidth: 18, height: 16, padding: '0 5px', boxSizing: 'border-box',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: 'var(--cth-coral)', color: 'var(--cth-ink-900)',
                      fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px'
                    }}
                  >{count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* The roster. */}
      <div className="cth-scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' }}>
        {gods.map(a => <SidebarAgentRow key={a.id} {...rowProps(a)} />)}
        {groups.map((g, i) => (
          <div
            key={g.key}
            style={{
              marginTop: (i > 0 || gods.length > 0) ? 10 : 0,
              paddingTop: (i > 0 || gods.length > 0) ? 8 : 0,
              borderTop: (i > 0 || gods.length > 0) ? '1px solid var(--cth-ink-300)' : 'none'
            }}
          >
            <div
              title={g.key}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '0 10px 4px',
                fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                color: 'var(--cth-ink-500)'
              }}
            >
              <span style={{ flexShrink: 0, display: 'inline-flex', opacity: 0.7 }}><Icon name="folder" /></span>
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {g.label.toUpperCase()}
              </span>
              <span style={{ marginInlineStart: 'auto', flexShrink: 0, color: 'var(--cth-ink-300)' }}>{g.members.length}</span>
            </div>
            {g.members.map(a => <SidebarAgentRow key={a.id} {...rowProps(a)} />)}
          </div>
        ))}
        {nothingMatches && (
          <div style={{
            padding: '12px 10px', fontFamily: 'var(--cth-font-ui)', fontSize: 12,
            color: 'var(--cth-ink-500)'
          }}>{t('officeSidebar.noMatches', { query: query.trim() })}</div>
        )}
      </div>

      {/* Footer: add, and last session's team. Pinned so a long roster can't
          scroll them out of reach. */}
      <div style={{
        flexShrink: 0, padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
        borderTop: '1px solid var(--cth-ink-300)'
      }}>
        <PixelButton variant="secondary" size="sm" style={{ width: '100%' }} onClick={() => setAddAgentOpen(true)}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
            <Icon name="plus" /> {t('agentStrip.addAgent')}
          </span>
        </PixelButton>
        {(restorableAgents.length > 0 || restoreBusy) && (
          <PixelButton
            variant="primary"
            size="sm"
            style={{ width: '100%' }}
            disabled={restoreBusy}
            onClick={() => { void restoreTeam(); }}
            title={restoreBusy
              ? t('agentStrip.restoringTitle')
              : t('agentStrip.restoreTitle', { names: restorableAgents.map((a: Agent) => a.name).join(', ') })}
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <Icon name="play" />
              {restoreBusy ? t('agentStrip.restoringTeam') : t('agentStrip.restoreAll', { count: restorableAgents.length })}
            </span>
          </PixelButton>
        )}
      </div>

      {noteEdit && editingAgent && (
        <>
          <div onClick={() => setNoteEdit(null)} style={{ position: 'fixed', inset: 0, zIndex: 349, background: 'transparent' }} />
          <div
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed', left: noteEdit.left, top: noteEdit.top, width: NOTE_W, zIndex: 350,
              padding: 10, boxSizing: 'border-box',
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300), 3px 3px 0 rgba(26,19,32,0.14)',
              display: 'flex', flexDirection: 'column', gap: 6
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                color: 'var(--cth-ink-500)'
              }}>{t('agentStrip.privateNote', { name: editingAgent.name.toUpperCase() })}</span>
              <button
                onClick={() => setNoteEdit(null)}
                title={t('agentStrip.done')}
                aria-label={t('agentStrip.closeNoteEditor')}
                style={{
                  flexShrink: 0, width: 18, height: 18, padding: 0, lineHeight: 1,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                  color: 'var(--cth-ink-500)', background: 'transparent',
                  border: 'none', cursor: 'pointer'
                }}
              >✕</button>
            </div>
            <textarea
              dir={rtl ? 'auto' : undefined}
              autoFocus
              rows={3}
              value={editingAgent.note ?? ''}
              onChange={(e) => setAgentNote(editingAgent.id, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setNoteEdit(null); }}
              placeholder={t('agentStrip.notePlaceholder')}
              aria-label={t('agentCard.noteAria', { name: editingAgent.name })}
              style={{
                width: '100%', padding: '6px 8px',
                border: 'none', outline: 'none', resize: 'none', boxSizing: 'border-box',
                background: 'var(--cth-cream-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                lineHeight: '18px', color: 'var(--cth-ink-900)'
              }}
            />
            <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>{t('agentStrip.oneLineOneBullet')}</span>
          </div>
        </>
      )}
    </aside>
  );
}

/** Drag-reorder wiring handed down to each row. */
interface RowDrag {
  enabled: boolean;
  dragId: string | null;
  overId: string | null;
  start: (id: string) => void;
  over: (id: string) => void;
  leave: (id: string) => void;
  drop: (id: string) => void;
  end: () => void;
}

interface SidebarAgentRowProps {
  agent: Agent;
  active: boolean;
  compact: boolean;
  /** Open hive questions this agent is waiting on the human for. */
  asks: number;
  doingCount: number;
  drag: RowDrag;
  rowRef: (el: HTMLButtonElement | null) => void;
  onClick: () => void;
  onAskClick: () => void;
  onDoingClick: () => void;
  onEditNote?: () => void;
}

function SidebarAgentRow({
  agent, active, compact, asks, doingCount, drag, rowRef,
  onClick, onAskClick, onDoingClick, onEditNote
}: SidebarAgentRowProps) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const typing = useHasTerminalDraft(agent.ptyId);
  const bullets = (agent.note ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  const live = liveLineFor(agent);
  const dragging = drag.dragId === agent.id;
  const dropTarget = drag.overId === agent.id && !!drag.dragId && drag.dragId !== agent.id;

  return (
    <button
      ref={rowRef}
      draggable={drag.enabled}
      onDragStart={(e) => { if (!drag.enabled) { e.preventDefault(); return; } drag.start(agent.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => {
        if (!drag.dragId || drag.dragId === agent.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        drag.over(agent.id);
      }}
      onDragLeave={() => drag.leave(agent.id)}
      onDrop={(e) => { e.preventDefault(); drag.drop(agent.id); }}
      onDragEnd={drag.end}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-current={active ? 'true' : undefined}
      title={agent.description || agent.project}
      style={{
        display: 'flex', gap: 8, alignItems: 'flex-start',
        width: '100%', padding: '5px 10px', border: 'none', boxSizing: 'border-box',
        cursor: drag.enabled ? 'grab' : 'pointer', textAlign: 'start',
        opacity: dragging ? 0.4 : 1,
        background: active ? 'var(--cth-cream-100)' : (hover ? 'var(--cth-cream-300)' : 'transparent'),
        // Selection is the same ink rule on every row, god included; the drop
        // cue is an insertion line on the inline-start edge.
        boxShadow: [
          active ? 'inset 3px 0 0 var(--cth-ink-900)' : '',
          dropTarget ? 'inset 0 2px 0 var(--cth-ink-900)' : ''
        ].filter(Boolean).join(', ') || 'none',
        color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)'
      }}
    >
      <span style={{
        width: 26, height: 30, flexShrink: 0, marginTop: 1,
        background: agent.isGod ? `var(--cth-${agent.accent})` : `var(--cth-${agent.accent}-light)`,
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'hidden'
      }}>
        <SpritePortrait character={agent.character} scale={1.5} />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{
            flex: 1, minWidth: 0,
            fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>{agent.name.toUpperCase()}</span>
          {agent.isGod && (
            <span style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 6, lineHeight: '10px',
              background: `var(--cth-${agent.accent})`, color: 'var(--cth-ink-900)',
              padding: '1px 3px 0', flexShrink: 0
            }}>{t('agentCard.boss')}</span>
          )}
          <PixelBadge status={typing ? 'typing' : agent.status} style={{ flexShrink: 0 }} />
        </span>
        {!compact && live && (
          <span
            title={live}
            style={{
              fontSize: 11, lineHeight: '14px', color: 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}
          >{live}</span>
        )}
        {(asks > 0 || doingCount > 0) && (
          <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            {asks > 0 && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onAskClick(); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onAskClick(); } }}
                title={t('officeSidebar.askedYouTitle', { name: agent.name, count: asks })}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  height: 16, padding: '0 6px',
                  background: 'var(--cth-coral)', color: 'var(--cth-ink-900)',
                  fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '10px',
                  cursor: 'pointer'
                }}
              >{t('officeSidebar.askedYou')}{asks > 1 ? ` ${asks}` : ''}</span>
            )}
            {doingCount > 0 && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onDoingClick(); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onDoingClick(); } }}
                title={doingCount === 1
                  ? t('agentCard.doingTasks', { count: doingCount })
                  : t('agentCard.doingTasksPlural', { count: doingCount })}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  height: 16, padding: '0 6px',
                  background: 'var(--cth-sky)', color: 'var(--cth-ink-900)',
                  fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '10px',
                  cursor: 'pointer'
                }}
              >✎ {doingCount}</span>
            )}
          </span>
        )}
        {(bullets.length > 0 || onEditNote) && (
          <span style={{ display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0 }}>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {bullets.map((b, i) => (
                <span
                  key={i}
                  title={agent.note}
                  style={{
                    fontSize: 10.5, lineHeight: '14px', fontStyle: 'italic',
                    color: 'var(--cth-ink-500)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}
                >• {b}</span>
              ))}
            </span>
            {onEditNote && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onEditNote(); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onEditNote(); } }}
                title={agent.note ? t('agentCard.editNote') : t('agentCard.addNote')}
                aria-label={t('agentCard.editNoteAria', { name: agent.name })}
                style={{
                  flexShrink: 0, width: 15, height: 14,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, lineHeight: 1, cursor: 'pointer',
                  // Quiet until the row is hovered or focused — discoverable, not noisy.
                  color: (hover || active) ? 'var(--cth-ink-500)' : 'var(--cth-ink-300)'
                }}
              >✎</span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}
