import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import type { OfficeManifest, PathMapping } from '@shared/officeMove';

/**
 * Settings → General → "Move to another computer".
 *
 * Export writes one `.tar.gz` of the office (agents, memory, tasks, inboxes,
 * notes, meetings, settings). Import reads one back on the other machine:
 * it shows where every folder the agents worked in used to be, with a guess
 * for where it is now, lets the user correct the guesses and pick the new
 * home, names the secrets that have to be typed again, and restarts the app
 * into the moved office.
 */

const mono: CSSProperties = { fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 12, lineHeight: '18px' };
const input: CSSProperties = {
  ...mono, flex: 1, minWidth: 0, padding: '4px 8px', boxSizing: 'border-box',
  border: 'none', outline: 'none', background: 'var(--cth-cream-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', color: 'var(--cth-ink-900)'
};
const label: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
};

interface Inspected {
  archive: string;
  manifest: OfficeManifest;
  platform: 'win32' | 'darwin' | 'linux';
  suggestedHome: string;
  mapping: PathMapping[];
}

export function OfficeMoveSection({ sectionHead }: { sectionHead: CSSProperties }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [plan, setPlan] = useState<Inspected | null>(null);
  const [newHome, setNewHome] = useState('');
  const [mapping, setMapping] = useState<PathMapping[]>([]);

  const doExport = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await window.cth.officeExport();
      if (r.ok) setNote({ kind: 'ok', text: t('settings.move.exported', { path: r.path, count: r.agentCount }) });
      else if (r.error !== 'cancelled') setNote({ kind: 'err', text: r.error });
    } catch (e) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const pickArchive = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await window.cth.officeInspect();
      if (!r.ok) { if (r.error !== 'cancelled') setNote({ kind: 'err', text: r.error }); return; }
      setPlan(r);
      setNewHome(r.suggestedHome);
      setMapping(r.mapping);
    } catch (e) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const browseHome = async () => {
    const r = await window.cth.chooseFolder();
    if (r.ok) setNewHome(r.path);
  };
  const browseMapping = async (i: number) => {
    const r = await window.cth.chooseFolder();
    if (r.ok) setMapping((m) => m.map((row, j) => (j === i ? { ...row, to: r.path } : row)));
  };

  const doImport = async () => {
    if (!plan || !newHome.trim()) return;
    setBusy(true); setNote(null);
    try {
      // Resolves only on failure: success relaunches the app.
      const r = await window.cth.officeImport({ archive: plan.archive, newHome: newHome.trim(), mapping });
      if (!r.ok) setNote({ kind: 'err', text: r.error });
      else setNote({ kind: 'ok', text: t('settings.move.restarting') });
    } catch (e) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const platformName = (p: string): string => (p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : 'Linux');

  return (
    <div>
      <div style={sectionHead}>{t('settings.move.title')}</div>
      <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
        {t('settings.move.desc')}
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <PixelButton variant="secondary" size="sm" onClick={() => { void doExport(); }} disabled={busy}>
          {t('settings.move.export')}
        </PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => { void pickArchive(); }} disabled={busy}>
          {t('settings.move.import')}
        </PixelButton>
      </div>
      {note && (
        <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: '18px', color: note.kind === 'err' ? 'var(--cth-coral)' : 'var(--cth-ink-700)', wordBreak: 'break-all' }}>
          {note.text}
        </p>
      )}

      {plan && (
        <div style={{
          marginTop: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          <div style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
            {t('settings.move.planSummary', {
              platform: platformName(plan.manifest.platform),
              date: new Date(plan.manifest.exportedAt).toLocaleString(),
              count: plan.manifest.agentCount,
              version: plan.manifest.appVersion
            })}
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={label}>{t('settings.move.newHome')}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={newHome} onChange={(e) => setNewHome(e.target.value)} style={input} spellCheck={false} />
              <PixelButton variant="secondary" size="sm" onClick={() => { void browseHome(); }}>{t('settings.move.browse')}</PixelButton>
            </div>
            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{t('settings.move.newHomeHint')}</span>
          </label>

          {mapping.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={label}>{t('settings.move.folders')}</span>
              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{t('settings.move.foldersHint')}</span>
              {mapping.map((row, i) => (
                <div key={row.from} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr) auto', gap: 6, alignItems: 'center' }}>
                  <span title={row.from} style={{ ...mono, color: 'var(--cth-ink-700)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'ltr' }}>{row.from}</span>
                  <span style={{ color: 'var(--cth-ink-500)' }}>→</span>
                  <input
                    value={row.to}
                    onChange={(e) => setMapping((m) => m.map((r, j) => (j === i ? { ...r, to: e.target.value } : r)))}
                    style={input}
                    spellCheck={false}
                    aria-label={t('settings.move.folderNow', { folder: row.from })}
                  />
                  <PixelButton variant="ghost" size="sm" onClick={() => { void browseMapping(i); }}>{t('settings.move.browse')}</PixelButton>
                </div>
              ))}
            </div>
          )}

          {plan.manifest.secretsToReenter.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>{t('settings.move.secrets')}</span>
              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                {t('settings.move.secretsHint')} {plan.manifest.secretsToReenter.join(' · ')}
              </span>
            </div>
          )}

          <p style={{ margin: 0, fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
            {t('settings.move.warning')}
          </p>

          <div style={{ display: 'flex', gap: 8 }}>
            <PixelButton variant="primary" size="sm" onClick={() => { void doImport(); }} disabled={busy || !newHome.trim()}>
              {busy ? t('settings.move.importing') : t('settings.move.importRestart')}
            </PixelButton>
            <PixelButton variant="ghost" size="sm" onClick={() => { setPlan(null); setNote(null); }} disabled={busy}>
              {t('common.cancel')}
            </PixelButton>
          </div>
        </div>
      )}
    </div>
  );
}
