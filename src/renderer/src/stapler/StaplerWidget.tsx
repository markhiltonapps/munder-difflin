import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { LevelBars } from './LevelBars';
import { useTranslation } from 'react-i18next';
import { SpritePortrait } from '@/components/SpritePortrait';
import { Icon, type IconName } from '@/components/Icon';
import { fmtClock } from '@shared/stapler';
import {
  EMPTY_REPORT, MAX_MESSAGE_MS, MAX_SHOTS, WIDGET_SIZE, shotsMessage, type StaplerReport
} from '@shared/staplerWidget';

/**
 * The floating Stapler — what the widget window draws.
 *
 * Closed: a face (your clone's portrait) you can drag around by its grip,
 * with a red ring while a meeting is being recorded. Click it and the ring
 * opens: screenshot, record a message, record the meeting, make invisible,
 * open the office, reset position, hide. Everything it catches goes to the
 * agent you pick from the To menu, which remembers who you picked.
 *
 * The meeting recorder lives in the main window; this window only shows its
 * state (relayed by main) and asks for it to start or stop. A voice message
 * is recorded HERE — a short clip through the same Groq transcription — and
 * read back before it is sent. Screenshots are taken by main (it owns the
 * screen); this window shows the results and composes the send.
 */

type Panel = null | 'message' | 'shots';
type MsgState = 'idle' | 'recording' | 'transcribing' | 'review';
interface Shot { path: string; name: string; thumb: string; width: number; height: number }

const TO_KEY = 'cth.stapler.to';

export function StaplerWidget() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<StaplerReport>(EMPTY_REPORT);
  const [invisible, setInvisible] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);
  const recording = report.status === 'recording' || report.status === 'starting';

  // Transparent window: nothing but what we draw.
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.backgroundImage = 'none';
    document.getElementById('root')?.style.setProperty('background', 'transparent');
  }, []);

  // The relay: ask once, then listen.
  useEffect(() => {
    const unsub = window.cth.onStaplerReport((r) => setReport(r));
    window.cth.staplerWidgetRequestReport();
    window.cth.staplerWidgetState().then((s) => setInvisible(s.invisible)).catch(() => { /* default */ });
    return unsub;
  }, []);

  const setRing = (next: boolean): void => {
    setOpen(next);
    window.cth.staplerWidgetRing(next);
    if (!next) setPanel(null);
  };

  // ─── To menu ────────────────────────────────────────────────────────────────
  const [to, setTo] = useState<string>(() => { try { return localStorage.getItem(TO_KEY) ?? ''; } catch { return ''; } });
  const agents = report.agents;
  const target = agents.find((a) => a.id === to) ?? agents.find((a) => a.isGod) ?? agents[0];
  const chooseTo = (id: string): void => {
    setTo(id);
    try { localStorage.setItem(TO_KEY, id); } catch { /* noop */ }
  };

  // ─── Voice message ─────────────────────────────────────────────────────────
  const [msg, setMsg] = useState<MsgState>('idle');
  const [msgText, setMsgText] = useState('');
  const [msgElapsed, setMsgElapsed] = useState(0);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: ReturnType<typeof setInterval>; cap: ReturnType<typeof setTimeout> } | null>(null);

  const stopMessage = useCallback((): void => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    clearInterval(r.timer); clearTimeout(r.cap);
    try { r.recorder.stop(); } catch { /* noop */ }
  }, []);

  const startMessage = async (): Promise<void> => {
    if (msg !== 'idle' && msg !== 'review') return;
    setError(null); setMsgText('');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      setError(name === 'NotAllowedError' ? t('staplerWidget.micDenied') : t('staplerWidget.micFailed'));
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    recorder.ondataavailable = (ev: BlobEvent) => { if (ev.data.size > 0) chunks.push(ev.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size === 0) { setMsg('idle'); setError(t('staplerWidget.nothingRecorded')); return; }
      setMsg('transcribing');
      try {
        const type = blob.type || 'audio/webm';
        const res = await window.cth.staplerTranscribe({
          audio: await blob.arrayBuffer(), mimeType: type.split(';')[0],
          filename: `message.${type.includes('ogg') ? 'ogg' : 'webm'}`
        });
        if (res.ok && res.text) { setMsgText(res.text); setMsg('review'); }
        else { setMsg('idle'); setError(res.error ?? t('staplerWidget.transcribeFailed')); }
      } catch (e) {
        setMsg('idle'); setError(e instanceof Error ? e.message : t('staplerWidget.transcribeFailed'));
      }
    };
    rec.current = {
      recorder, stream, chunks,
      timer: setInterval(() => setMsgElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500),
      cap: setTimeout(() => stopMessage(), MAX_MESSAGE_MS)
    };
    setMsgElapsed(0);
    recorder.start();
    setMsg('recording');
    setPanel('message');
  };
  useEffect(() => () => stopMessage(), [stopMessage]);

  // ─── Screenshots ───────────────────────────────────────────────────────────
  const [shots, setShots] = useState<Shot[]>([]);
  const [note, setNote] = useState('');
  const [shooting, setShooting] = useState(false);
  const takeShot = async (): Promise<void> => {
    if (shooting || shots.length >= MAX_SHOTS) return;
    setShooting(true); setError(null);
    try {
      const res = await window.cth.staplerScreenshot();
      if (res.ok) { setShots((prev) => [...prev, res].slice(0, MAX_SHOTS)); setPanel('shots'); }
      else if (res.error !== 'cancelled') setError(res.error);
    } finally { setShooting(false); }
  };

  // ─── Send ──────────────────────────────────────────────────────────────────
  const [sent, setSent] = useState<string | null>(null);
  const flash = (s: string): void => { setSent(s); setTimeout(() => setSent(null), 2500); };
  const sendMessage = (): void => {
    if (!target || !msgText.trim()) return;
    window.cth.staplerWidgetDeliver({ agentId: target.id, text: msgText.trim() });
    setMsg('idle'); setMsgText(''); setPanel(null);
    flash(t('staplerWidget.sentTo', { name: target.name }));
  };
  const sendShots = (): void => {
    if (!target || shots.length === 0) return;
    window.cth.staplerWidgetDeliver({ agentId: target.id, text: shotsMessage(note, shots) });
    setShots([]); setNote(''); setPanel(null);
    flash(t('staplerWidget.sentTo', { name: target.name }));
  };

  const toggleInvisible = async (): Promise<void> => {
    const r = await window.cth.staplerWidgetSetInvisible(!invisible);
    setInvisible(r.invisible);
  };

  // ─── Closed: the face ───────────────────────────────────────────────────────
  if (!open) {
    return (
      <div style={{ width: WIDGET_SIZE.closed.width, height: WIDGET_SIZE.closed.height, display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: 'var(--cth-font-ui)' }}>
        <Grip />
        <button
          onClick={() => setRing(true)}
          title={recording ? t('staplerWidget.faceRecordingTitle', { time: fmtClock(report.elapsed) }) : t('staplerWidget.faceTitle')}
          aria-label={t('staplerWidget.faceTitle')}
          style={{
            width: 72, height: 72, borderRadius: '50%', padding: 0, border: 'none', cursor: 'pointer',
            background: 'var(--cth-cream-100)',
            boxShadow: recording
              ? '0 0 0 3px var(--cth-coral), 0 0 0 5px var(--cth-ink-900), 2px 3px 0 3px rgba(26,19,32,0.25)'
              : '0 0 0 2px var(--cth-ink-900), 2px 3px 0 2px rgba(26,19,32,0.25)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'hidden'
          }}
        >
          <span style={{ marginTop: 6 }}><SpritePortrait character="michael" scale={2.5} /></span>
        </button>
        <div style={{
          marginTop: 4, fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '12px',
          color: 'var(--cth-cream-100)', textShadow: '0 0 2px var(--cth-ink-900), 0 0 2px var(--cth-ink-900)',
          whiteSpace: 'nowrap'
        }}>
          {recording ? `● ${fmtClock(report.elapsed)}` : sent ? '✓' : ''}
        </div>
        {recording && (
          <div style={{ marginTop: 2, display: 'flex', gap: 8, padding: '2px 6px', background: 'rgba(26,19,32,0.72)', borderRadius: 4 }}>
            <LevelBars lit={report.levels.you} label={t('staplerWidget.you')} title={t('staplerWidget.youMeter')} />
            <LevelBars lit={report.themAvailable ? report.levels.them : 0} label={t('staplerWidget.them')} title={report.themAvailable ? t('staplerWidget.themMeter') : t('staplerWidget.themOff')} />
          </div>
        )}
      </div>
    );
  }

  // ─── Open: the ring ─────────────────────────────────────────────────────────
  const actions: Array<{ key: string; icon: IconName; label: string; on?: boolean; busy?: boolean; disabled?: boolean; run: () => void }> = [
    { key: 'shot', icon: 'image', label: t('staplerWidget.screenshot'), busy: shooting, disabled: shots.length >= MAX_SHOTS, run: () => { void takeShot(); } },
    { key: 'message', icon: 'mic', label: msg === 'recording' ? t('staplerWidget.stopMessage', { time: fmtClock(msgElapsed) }) : t('staplerWidget.recordMessage'), on: msg === 'recording', busy: msg === 'transcribing', run: () => { if (msg === 'recording') stopMessage(); else void startMessage(); } },
    { key: 'meeting', icon: recording ? 'pause' : 'play', label: recording ? t('staplerWidget.stopMeeting', { time: fmtClock(report.elapsed) }) : t('staplerWidget.recordMeeting'), on: recording, busy: report.status === 'starting', run: () => window.cth.staplerWidgetToggleMeeting() },
    { key: 'invisible', icon: 'minimize', label: invisible ? t('staplerWidget.visible') : t('staplerWidget.invisible'), on: invisible, run: () => { void toggleInvisible(); } },
    { key: 'office', icon: 'terminal', label: t('staplerWidget.openOffice'), run: () => window.cth.staplerWidgetFocusMain() },
    { key: 'reset', icon: 'expand', label: t('staplerWidget.reset'), run: () => window.cth.staplerWidgetReset() }
  ];

  return (
    <div style={{
      width: WIDGET_SIZE.open.width, height: WIDGET_SIZE.open.height, boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column',
      background: 'var(--cth-cream-100)', color: 'var(--cth-ink-900)',
      boxShadow: 'inset 0 0 0 2px var(--cth-ink-900), 3px 4px 0 rgba(26,19,32,0.22)',
      fontFamily: 'var(--cth-font-ui)', overflow: 'hidden'
    }}>
      {/* Header = drag handle. */}
      <div className="cth-titlebar-drag" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 6px 10px', background: 'var(--cth-cream-200)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-300)', userSelect: 'none' }}>
        <span style={{ width: 24, height: 28, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
          <SpritePortrait character="michael" scale={1.5} />
        </span>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, flex: 1 }}>{t('staplerWidget.title')}</span>
        {recording && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <LevelBars lit={report.levels.you} label={t('staplerWidget.you')} title={t('staplerWidget.youMeter')} />
            <LevelBars lit={report.themAvailable ? report.levels.them : 0} label={t('staplerWidget.them')} title={report.themAvailable ? t('staplerWidget.themMeter') : t('staplerWidget.themOff')} />
            <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-coral)' }}>● {fmtClock(report.elapsed)}</span>
          </span>
        )}
        <button className="cth-titlebar-nodrag" onClick={() => window.cth.staplerWidgetHide()} title={t('staplerWidget.hide')} aria-label={t('staplerWidget.hide')} style={iconBtn}>
          <Icon name="x" />
        </button>
        <button className="cth-titlebar-nodrag" onClick={() => setRing(false)} title={t('staplerWidget.collapse')} aria-label={t('staplerWidget.collapse')} style={iconBtn}>
          <Icon name="minimize" />
        </button>
      </div>

      {/* The ring. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, padding: 8, flexShrink: 0 }}>
        {actions.map((a) => (
          <button
            key={a.key}
            onClick={a.run}
            disabled={a.disabled || a.busy}
            aria-pressed={a.on}
            style={{
              height: 58, padding: '4px 2px', border: 'none', cursor: a.disabled ? 'default' : 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
              background: a.on ? 'var(--cth-coral)' : 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              color: 'var(--cth-ink-900)', opacity: a.disabled ? 0.5 : 1,
              fontFamily: 'var(--cth-font-ui)', fontSize: 10.5, lineHeight: '13px', textAlign: 'center'
            }}
          >
            <Icon name={a.icon} />
            <span>{a.busy ? '…' : a.label}</span>
          </button>
        ))}
      </div>

      {/* The working panel. */}
      <div className="cth-scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {error && <div style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{error}</div>}
        {sent && <div style={{ fontSize: 11, color: 'var(--cth-mint)' }}>{sent}</div>}

        {panel === 'message' && (
          <>
            {msg === 'recording' && <div style={{ fontSize: 12 }}>{t('staplerWidget.listening', { time: fmtClock(msgElapsed), max: fmtClock(MAX_MESSAGE_MS / 1000) })}</div>}
            {msg === 'transcribing' && <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('staplerWidget.transcribing')}</div>}
            {msg === 'review' && (
              <textarea
                autoFocus
                value={msgText}
                onChange={(e) => setMsgText(e.target.value)}
                rows={5}
                aria-label={t('staplerWidget.messageLabel')}
                style={textarea}
              />
            )}
          </>
        )}

        {panel === 'shots' && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {shots.map((s) => (
                <span key={s.path} title={`${s.name} · ${s.width}×${s.height}`} style={{ position: 'relative', width: 64, height: 44, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', overflow: 'hidden' }}>
                  <img src={s.thumb} alt={s.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  <button
                    onClick={() => setShots((prev) => prev.filter((x) => x.path !== s.path))}
                    title={t('staplerWidget.removeShot')}
                    aria-label={t('staplerWidget.removeShot')}
                    style={{ position: 'absolute', top: 0, right: 0, width: 16, height: 16, padding: 0, border: 'none', background: 'var(--cth-ink-900)', color: 'var(--cth-cream-100)', fontSize: 10, lineHeight: 1, cursor: 'pointer' }}
                  >✕</button>
                </span>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--cth-ink-500)' }}>{t('staplerWidget.shotsCount', { count: shots.length, max: MAX_SHOTS })}</div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={t('staplerWidget.notePlaceholder')}
              aria-label={t('staplerWidget.noteLabel')}
              style={textarea}
            />
          </>
        )}

        {panel === null && (
          <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>
            {recording
              ? t('staplerWidget.meetingHint', { pending: report.pending })
              : t('staplerWidget.idleHint')}
          </div>
        )}
      </div>

      {/* To + send. */}
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 1px 0 var(--cth-ink-300)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 7, color: 'var(--cth-ink-500)', flexShrink: 0 }}>{t('staplerWidget.to')}</span>
          <select
            value={target?.id ?? ''}
            onChange={(e) => chooseTo(e.target.value)}
            aria-label={t('staplerWidget.to')}
            style={{ ...input, flex: 1, minWidth: 0, padding: '3px 6px' }}
          >
            {agents.length === 0 && <option value="">{t('staplerWidget.noAgents')}</option>}
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isGod ? ' ★' : ''}</option>)}
          </select>
        </div>
        {panel === 'message' && msg === 'review' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={sendMessage} disabled={!target || !msgText.trim()} style={primaryBtn}>{t('staplerWidget.send')}</button>
            <button onClick={() => { setMsg('idle'); setMsgText(''); setPanel(null); }} style={ghostBtn}>{t('staplerWidget.discard')}</button>
          </div>
        )}
        {panel === 'shots' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={sendShots} disabled={!target || shots.length === 0} style={primaryBtn}>{t('staplerWidget.sendShots', { count: shots.length })}</button>
            <button onClick={() => { setShots([]); setNote(''); setPanel(null); }} style={ghostBtn}>{t('staplerWidget.discard')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The grip above the face: the only part of the closed widget that drags
 *  (a dragging region takes no clicks, so the face itself cannot be one). */
function Grip() {
  const { t } = useTranslation();
  return (
    <div
      className="cth-titlebar-drag"
      title={t('staplerWidget.dragHint')}
      style={{ width: 44, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, cursor: 'grab', marginBottom: 2 }}
    >
      {[0, 1, 2, 3].map((i) => <span key={i} style={{ width: 4, height: 4, background: 'var(--cth-cream-100)', boxShadow: '0 0 0 1px var(--cth-ink-900)' }} />)}
    </div>
  );
}

const iconBtn: CSSProperties = {
  width: 22, height: 22, padding: 0, border: 'none', cursor: 'pointer',
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-900)', flexShrink: 0
};
const input: CSSProperties = {
  boxSizing: 'border-box', border: 'none', outline: 'none',
  background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)'
};
const textarea: CSSProperties = { ...input, width: '100%', padding: '6px 8px', resize: 'none' };
const primaryBtn: CSSProperties = {
  flex: 1, height: 28, border: 'none', cursor: 'pointer',
  background: 'var(--cth-ink-900)', color: 'var(--cth-cream-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12
};
const ghostBtn: CSSProperties = {
  height: 28, padding: '0 10px', border: 'none', cursor: 'pointer',
  background: 'transparent', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)', fontSize: 12
};
