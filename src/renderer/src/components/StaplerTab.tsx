import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { staplerSession, useStapler } from '@/stapler/session';
import { useRtl } from '@/i18n/useDirection';
import { fmtClock, sortSegments, type StaplerMeetingSummary } from '@shared/stapler';

/**
 * STAPLER — meetings, transcribed, handed to an agent.
 *
 * Record captures your microphone as You and the system audio as Them (where
 * the platform allows — see stapler/session.ts), transcribes both in chunks as
 * the call goes on, and shows the dialogue here as it lands. Every line is a
 * text box: correct a name, cut a false start. Add a title and a description,
 * pick an agent, say what you want done, and the transcript is written to
 * disk and the agent is queued a message pointing at it.
 *
 * The recorder is a module singleton: switching tabs mid-meeting changes
 * nothing. This component only renders its state.
 */

const label: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
};
const input: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
  border: 'none', outline: 'none',
  background: 'var(--cth-cream-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)'
};

export function StaplerTab() {
  const { t } = useTranslation();
  const rtl = useRtl();
  const st = useStapler();
  const agents = useStore((s) => s.agents);
  const hasGroqKey = useStore((s) => s.hasGroqKey);
  const recording = st.status === 'recording';
  const busy = st.status === 'starting' || st.status === 'stopping';

  // Past meetings, newest first. Refreshed when a meeting stops or saves.
  const [meetings, setMeetings] = useState<StaplerMeetingSummary[]>([]);
  const refresh = useCallback(async () => {
    try { setMeetings(await window.cth.staplerList()); } catch { /* keep last good */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, st.status, st.markdownPath]);

  // The floating widget's state, kept in step by main's broadcast.
  const [widget, setWidget] = useState<{ open: boolean; invisible: boolean }>({ open: false, invisible: false });
  useEffect(() => {
    let alive = true;
    window.cth.staplerWidgetState().then((s) => { if (alive) setWidget(s); }).catch(() => { /* default */ });
    const unsub = window.cth.onStaplerWidgetChanged((s) => setWidget(s));
    return () => { alive = false; unsub(); };
  }, []);

  const [loopback, setLoopback] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    window.cth.staplerCapabilities().then((c) => { if (alive) setLoopback(c.loopback); }).catch(() => { /* unknown */ });
    return () => { alive = false; };
  }, []);

  // Send panel. Default target: the orchestrator, else the first live agent.
  const live = useMemo(() => agents.filter((a) => a.ptyId), [agents]);
  const [targetId, setTargetId] = useState<string>('');
  useEffect(() => {
    if (targetId && live.some((a) => a.id === targetId)) return;
    setTargetId(live.find((a) => a.isGod)?.id ?? live[0]?.id ?? '');
  }, [live, targetId]);
  const [instruction, setInstruction] = useState('');
  const [sendNote, setSendNote] = useState('');
  const [widgetNote, setWidgetNote] = useState('');
  const [sending, setSending] = useState(false);
  const target = live.find((a) => a.id === targetId);
  const send = async () => {
    if (!target || sending) return;
    setSending(true); setSendNote('');
    const res = await staplerSession.sendToAgent(target.id, instruction);
    setSending(false);
    setSendNote(res.ok ? t('stapler.sent', { name: target.name }) : (res.error ?? t('stapler.sendFailed')));
  };

  // Delete is two clicks: the second within three seconds.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  useEffect(() => {
    if (!armedDelete) return;
    const id = setTimeout(() => setArmedDelete(null), 3000);
    return () => clearTimeout(id);
  }, [armedDelete]);
  const del = async (id: string) => {
    if (armedDelete !== id) { setArmedDelete(id); return; }
    setArmedDelete(null);
    await window.cth.staplerDelete(id);
    if (st.meeting?.id === id) staplerSession.close();
    void refresh();
  };

  const openSettings = () => window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Voice' } }));

  const m = st.meeting;
  const segments = useMemo(() => (m ? sortSegments(m.segments) : []), [m]);

  // Docked in the sidebar the panel is ~400px wide: a 200px meetings column
  // would leave the transcript narrower than a tweet. Below the threshold the
  // list becomes a picker row above the meeting instead. Measured on the panel
  // itself, like AgentDetailPanel's header, so the rule cannot oscillate.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setNarrow(w < 640);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const openMeeting = (id: string) => {
    if (recording) return;
    void window.cth.staplerGet(id).then((mm) => { if (mm) staplerSession.open(mm); });
  };

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', fontFamily: 'var(--cth-font-ui)' }}>
      {/* Control bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '8px 10px', borderBottom: '1px solid var(--cth-ink-300)', background: 'var(--cth-cream-200)', flexShrink: 0
      }}>
        <PixelButton
          variant={recording ? 'destructive' : 'primary'}
          size="md"
          disabled={busy}
          onClick={() => staplerSession.toggle()}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <Icon name={recording ? 'pause' : 'mic'} />
            {st.status === 'starting' ? t('stapler.starting') : recording ? t('stapler.stop') : t('stapler.record')}
          </span>
        </PixelButton>
        {(recording || st.status === 'starting') && (
          <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 13, color: 'var(--cth-ink-900)' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--cth-coral)', marginInlineEnd: 6, verticalAlign: 'middle' }} />
            {fmtClock(st.elapsed)}
          </span>
        )}
        <Side on={recording || st.status === 'starting'} label={t('stapler.you')} detail={t('stapler.youDetail')} />
        <Side
          on={(recording || st.status === 'starting') && st.themAvailable === true}
          label={t('stapler.them')}
          detail={
            st.themAvailable === false ? (loopback === false ? t('stapler.themUnsupported') : t('stapler.themMissing'))
              : loopback === false ? t('stapler.themUnsupported') : t('stapler.themDetail')
          }
        />
        {st.pending > 0 && (
          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('stapler.transcribing', { count: st.pending })}</span>
        )}
        <span style={{ marginInlineStart: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <PixelButton
            variant={widget.open ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => { void window.cth.staplerWidgetToggle().then((r) => { if (!r.ok && r.error) setWidgetNote(r.error); }); }}
          >
            <span className="cth-tip cth-tip-wrap" data-tip={t('stapler.widgetTip')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="expand" /> {widget.open ? t('stapler.widgetHide') : t('stapler.widgetShow')}
            </span>
          </PixelButton>
          {widget.open && (
            <PixelButton
              variant={widget.invisible ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => { void window.cth.staplerWidgetSetInvisible(!widget.invisible); }}
            >
              <span className="cth-tip cth-tip-wrap" data-tip={t('stapler.invisibleTip')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="minimize" /> {widget.invisible ? t('stapler.visible') : t('stapler.invisible')}
              </span>
            </PixelButton>
          )}
        </span>
        <span style={{ flexBasis: '100%', fontSize: 11, color: 'var(--cth-ink-500)' }}>
          {t('stapler.hotkey')}{widgetNote ? ` · ${widgetNote}` : ''}
        </span>
        {st.error && (
          <span style={{ flexBasis: '100%', fontSize: 12, color: 'var(--cth-coral)' }}>{st.error}</span>
        )}
      </div>

      {!hasGroqKey && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', flexShrink: 0,
          background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-300)'
        }}>
          <span style={{ flex: 1, fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)' }}>{t('stapler.needKey')}</span>
          <PixelButton variant="secondary" size="sm" onClick={openSettings}>{t('stapler.openSettings')}</PixelButton>
        </div>
      )}

      {narrow && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexShrink: 0, borderBottom: '1px solid var(--cth-ink-300)', background: 'var(--cth-cream-200)' }}>
          <span style={{ ...label, whiteSpace: 'nowrap' }}>{t('stapler.meetings')}</span>
          <select
            value={m?.id ?? ''}
            disabled={recording}
            onChange={(e) => { if (e.target.value) openMeeting(e.target.value); else staplerSession.close(); }}
            aria-label={t('stapler.meetings')}
            style={{ ...input, flex: 1, minWidth: 0, padding: '3px 6px' }}
          >
            <option value="">{meetings.length === 0 ? t('stapler.noMeetings') : t('stapler.pickMeeting')}</option>
            {meetings.map((row) => (
              <option key={row.id} value={row.id}>{row.title || t('stapler.untitled')} · {new Date(row.startedAt).toLocaleDateString()}</option>
            ))}
          </select>
          {m && !recording && (
            <button
              onClick={() => { void del(m.id); }}
              title={t('stapler.delete')}
              aria-label={t('stapler.delete')}
              style={{ flexShrink: 0, padding: '0 4px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: armedDelete === m.id ? 10 : 12, color: armedDelete === m.id ? 'var(--cth-coral)' : 'var(--cth-ink-500)', fontFamily: armedDelete === m.id ? 'var(--cth-font-display)' : 'inherit' }}
            >{armedDelete === m.id ? t('stapler.sure') : '✕'}</button>
          )}
          <PixelButton variant="ghost" size="sm" onClick={openSettings}>{t('stapler.vocabulary')}</PixelButton>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Meetings list */}
        {!narrow && (
        <div style={{
          width: 200, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
          borderInlineEnd: '1px solid var(--cth-ink-300)', background: 'var(--cth-cream-200)'
        }}>
          <div style={{ ...label, padding: '8px 10px 4px' }}>{t('stapler.meetings')}</div>
          <div className="cth-scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {meetings.length === 0 && (
              <div style={{ padding: '4px 10px 10px', fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('stapler.noMeetings')}</div>
            )}
            {meetings.map((row) => {
              const active = m?.id === row.id;
              const isLive = active && recording;
              return (
                <div
                  key={row.id}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 4, padding: '6px 6px 6px 10px',
                    background: active ? 'var(--cth-cream-100)' : 'transparent',
                    boxShadow: active ? 'inset 3px 0 0 var(--cth-ink-900)' : 'none'
                  }}
                >
                  <button
                    onClick={() => openMeeting(row.id)}
                    disabled={recording && !active}
                    style={{
                      flex: 1, minWidth: 0, padding: 0, border: 'none', background: 'transparent',
                      cursor: recording && !active ? 'default' : 'pointer', textAlign: 'start',
                      color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)'
                    }}
                  >
                    <div style={{ fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {isLive && <span style={{ display: 'inline-block', width: 6, height: 6, background: 'var(--cth-coral)', marginInlineEnd: 5, verticalAlign: 'middle' }} />}
                      {row.title || t('stapler.untitled')}
                    </div>
                    <div style={{ fontSize: 10.5, lineHeight: '14px', color: 'var(--cth-ink-500)' }}>
                      {new Date(row.startedAt).toLocaleString()} · {t('stapler.segments', { count: row.segmentCount })}
                    </div>
                  </button>
                  {!isLive && (
                    <button
                      onClick={() => { void del(row.id); }}
                      title={t('stapler.delete')}
                      aria-label={t('stapler.delete')}
                      style={{
                        flexShrink: 0, padding: '0 4px', border: 'none', background: 'transparent', cursor: 'pointer',
                        fontSize: armedDelete === row.id ? 10 : 11, lineHeight: '16px',
                        color: armedDelete === row.id ? 'var(--cth-coral)' : 'var(--cth-ink-300)',
                        fontFamily: armedDelete === row.id ? 'var(--cth-font-display)' : 'inherit'
                      }}
                    >{armedDelete === row.id ? t('stapler.sure') : '✕'}</button>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ padding: 8, borderTop: '1px solid var(--cth-ink-300)' }}>
            <PixelButton variant="ghost" size="sm" onClick={openSettings} style={{ width: '100%' }}>
              {t('stapler.vocabulary')}
            </PixelButton>
          </div>
        </div>
        )}

        {/* The meeting */}
        {!m ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <div style={{ maxWidth: 420, textAlign: 'center', fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
              <div style={{ ...label, marginBottom: 8 }}>{t('stapler.title')}</div>
              {t('stapler.empty')}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 10px 6px', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, borderBottom: '1px solid var(--cth-ink-300)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  dir={rtl ? 'auto' : undefined}
                  value={m.title}
                  onChange={(e) => staplerSession.setTitle(e.target.value)}
                  placeholder={t('stapler.titlePlaceholder')}
                  aria-label={t('stapler.titleLabel')}
                  style={{ ...input, fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px', flex: 1 }}
                />
                {!recording && (
                  <PixelButton variant="ghost" size="sm" onClick={() => staplerSession.close()}>{t('stapler.close')}</PixelButton>
                )}
              </div>
              <textarea
                dir={rtl ? 'auto' : undefined}
                rows={2}
                value={m.description}
                onChange={(e) => staplerSession.setDescription(e.target.value)}
                placeholder={t('stapler.descriptionPlaceholder')}
                aria-label={t('stapler.descriptionLabel')}
                style={{ ...input, resize: 'vertical', fontSize: 12, lineHeight: '16px' }}
              />
            </div>

            {/* Transcript */}
            <div className="cth-scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 10px' }}>
              {segments.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', padding: '8px 0' }}>
                  {recording ? t('stapler.listening') : t('stapler.noSegments')}
                </div>
              )}
              {segments.map((seg) => (
                <SegmentRow
                  key={seg.id}
                  who={seg.who}
                  t0={seg.t0}
                  text={seg.text}
                  onChange={(text) => staplerSession.setSegmentText(seg.id, text)}
                  onRemove={() => staplerSession.removeSegment(seg.id)}
                  youLabel={t('stapler.you')}
                  themLabel={t('stapler.them')}
                  removeLabel={t('stapler.remove')}
                  rtl={rtl}
                />
              ))}
            </div>

            {/* Send */}
            <div style={{ padding: '8px 10px', borderTop: '1px solid var(--cth-ink-300)', background: 'var(--cth-cream-200)', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                <span style={{ ...label, whiteSpace: 'nowrap', flexShrink: 0 }}>{t('stapler.sendTo')}</span>
                <select
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  aria-label={t('stapler.sendTo')}
                  style={{ ...input, flex: 1, minWidth: 0, padding: '3px 6px' }}
                >
                  {live.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isGod ? ` · ${t('agentCard.boss')}` : ''}</option>)}
                </select>
              </div>
              <textarea
                dir={rtl ? 'auto' : undefined}
                rows={2}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={t('stapler.instructionPlaceholder')}
                aria-label={t('stapler.instructionLabel')}
                style={{ ...input, resize: 'vertical', fontSize: 12, lineHeight: '16px' }}
              />
              <PixelButton variant="primary" size="sm" disabled={!target || sending || segments.length === 0} onClick={() => { void send(); }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="arrow-right" /> {target ? t('stapler.send', { name: target.name }) : t('stapler.noAgent')}
                </span>
              </PixelButton>
              {sendNote && <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{sendNote}</span>}
              {st.markdownPath && (
                <span title={st.markdownPath} style={{ fontSize: 10.5, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'ltr', textAlign: 'start' }}>
                  {st.markdownPath}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One side's indicator in the control bar: a dot that is lit while that side
 *  is being captured, the side's name, and a word on where it comes from. */
function Side({ on, label: name, detail }: { on: boolean; label: string; detail: string }) {
  return (
    <span title={detail} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: on ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)' }}>
      <span style={{ width: 8, height: 8, background: on ? 'var(--cth-mint)' : 'var(--cth-ink-300)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }} />
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8 }}>{name.toUpperCase()}</span>
      <span style={{ fontSize: 11 }}>{detail}</span>
    </span>
  );
}

function SegmentRow({ who, t0, text, onChange, onRemove, youLabel, themLabel, removeLabel, rtl }: {
  who: 'you' | 'them'; t0: number; text: string;
  onChange: (text: string) => void; onRemove: () => void;
  youLabel: string; themLabel: string; removeLabel: string; rtl: boolean;
}) {
  const [hover, setHover] = useState(false);
  // The box grows with its text — a fixed row count hides the end of a long
  // turn behind a scrollbar nobody will find. Measured after every change and
  // again when the panel is resized.
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = (): void => { el.style.height = '0px'; el.style.height = `${el.scrollHeight}px`; };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement ?? el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0', borderBottom: '1px solid var(--cth-ink-100)' }}
    >
      <span style={{ flexShrink: 0, width: 38, fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '18px', color: 'var(--cth-ink-500)', direction: 'ltr' }}>
        {fmtClock(t0)}
      </span>
      <span style={{
        flexShrink: 0, minWidth: 34, textAlign: 'center', padding: '2px 4px', marginTop: 2,
        fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '12px',
        background: who === 'you' ? 'var(--cth-sky)' : 'var(--cth-lemon)', color: 'var(--cth-ink-900)'
      }}>{(who === 'you' ? youLabel : themLabel).toUpperCase()}</span>
      <textarea
        ref={ref}
        dir={rtl ? 'auto' : undefined}
        rows={1}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1, minWidth: 0, padding: '1px 4px', border: 'none', outline: 'none', resize: 'none', overflow: 'hidden',
          background: 'transparent', fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)'
        }}
      />
      <button
        onClick={onRemove}
        title={removeLabel}
        aria-label={removeLabel}
        style={{
          flexShrink: 0, width: 18, height: 18, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer',
          fontSize: 11, color: hover ? 'var(--cth-ink-500)' : 'transparent'
        }}
      >✕</button>
    </div>
  );
}
