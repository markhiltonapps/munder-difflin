import { useState, useEffect, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig, AgentProvider } from '@/store/config';
import { PixelButton } from './PixelButton';
import { ProviderLogo } from './ProviderLogo';
import { OSS_BLOG_LINKS } from '@shared/ossModels';
import { useStore } from '@/store/store';
import { AGENT_PROVIDER_PRESETS } from '@shared/agentProvider';
import {
  REASONING_EFFORTS, SUGGESTED_TIERS, TIER_NAMES, normalizeTier,
  type ModelTier, type ModelTiers, type TierName
} from '@shared/modelTiers';
import type { ProbeResult } from '../../../main/openrouter';

/**
 * AiEnginesSettings — the v0.3.1 per-provider config surface for the BYOK CLI
 * engines (OpenCode · Crush · pi.dev · Qwen). Two stores by what the datum is:
 *  - API keys → WRITE-ONLY in the secret broker (`providerKey:*` IPC). Keyed by the
 *    BACKEND model-provider (anthropic/openai/…). The field shows only set/not-set;
 *    the plaintext is never read back to the renderer (materialized MAIN-only at spawn).
 *  - Local base-URL + default model → HarnessConfig (`providerBaseUrls` /
 *    `providerDefaultModels`), keyed by CLI provider. Non-secret; normal config save.
 * See hive/shared/cli-agents/settings-ui-schema.md.
 */

/** Backend model-providers whose keys the CLIs read from standard env vars. Must
 *  match BACKEND_KEY_ENV in src/main/index.ts. */
const BACKENDS: Array<{ id: string; label: string; envVar: string }> = [
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { id: 'google', label: 'Google · Gemini', envVar: 'GEMINI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
  { id: 'groq', label: 'Groq', envVar: 'GROQ_API_KEY' }
];

/** CLI engines that take a per-provider local base-URL + default model. `hint`
 *  values are technical endpoint descriptions — kept English (technical data). */
const CLIS: Array<{ id: AgentProvider; label: string; hint: string }> = [
  { id: 'opencode', label: 'OpenCode', hint: 'http://localhost:11434/v1 (Ollama) — injected as a local provider' },
  { id: 'crush', label: 'Crush', hint: 'OpenAI-compatible endpoint — used as the proxy upstream' },
  { id: 'pi', label: 'Pi', hint: 'local models are file-based (models.json); base-URL reserved' },
  { id: 'qwen', label: 'Qwen', hint: 'OpenAI-compatible endpoint — used as the proxy upstream' }
];

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};
const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};
const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
};
const linkStyle: CSSProperties = { color: 'var(--cth-ink-900)', textDecoration: 'underline', cursor: 'pointer' };

export function AiEnginesSettings({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  // Keep the global "OpenAI key present" signal (boolean only) live so the Talk
  // button's missing-key warning clears the instant the user saves their OpenAI key
  // here — without it the gate only refreshes on next app start. apikey:openai is
  // the same key the Realtime mint reads; saving/clearing it flips the gate.
  const setHasOpenAiKey = useStore((s) => s.setHasOpenAiKey);
  // Which backends already have a key stored (boolean only — never the value).
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  // Where that key comes from: 'env' means the app found it in the environment
  // it was launched with (OPENROUTER_API_KEY in the shell profile) — set, but
  // not something Settings can delete.
  const [keySource, setKeySource] = useState<Record<string, 'settings' | 'env' | null>>({});
  // OpenRouter "Test connection".
  const [probing, setProbing] = useState(false);
  const [probeExtra, setProbeExtra] = useState('');
  const [probe, setProbe] = useState<{ results?: ProbeResult[]; error?: string } | null>(null);
  // Model tiers — drafts mirror config; each field saves on blur/change.
  const [tiers, setTiers] = useState<ModelTiers>(config.modelTiers ?? {});
  const [tierDraft, setTierDraft] = useState<Record<TierName, { provider: string; model: string; effort: string; maxOutputTokens: string }>>(() => {
    const d = {} as Record<TierName, { provider: string; model: string; effort: string; maxOutputTokens: string }>;
    for (const n of TIER_NAMES) {
      const t = config.modelTiers?.[n];
      d[n] = { provider: t?.provider ?? 'opencode', model: t?.model ?? '', effort: t?.effort ?? '', maxOutputTokens: t?.maxOutputTokens ? String(t.maxOutputTokens) : '' };
    }
    return d;
  });
  const [tierNote, setTierNote] = useState('');
  const [draftKey, setDraftKey] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  // Base-URL + default-model drafts, seeded from config.
  const [baseUrls, setBaseUrls] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerBaseUrls ?? {}
  );
  const [models, setModels] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerDefaultModels ?? {}
  );

  // Reseed set/not-set flags on mount (write-only — only the boolean is fetched).
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, boolean> = {};
      const src: Record<string, 'settings' | 'env' | null> = {};
      for (const b of BACKENDS) {
        try { out[b.id] = await window.cth.providerKeyHas(b.id); } catch { out[b.id] = false; }
        try { src[b.id] = (await window.cth.providerKeySource?.(b.id)) ?? null; } catch { src[b.id] = null; }
      }
      if (alive) { setHasKey(out); setKeySource(src); }
    })();
    return () => { alive = false; };
  }, []);

  const saveKey = async (backend: string) => {
    const key = (draftKey[backend] ?? '').trim();
    if (!key) return;
    try {
      const r = await window.cth.providerKeySet({ backend, key });
      if (r.ok) {
        setHasKey((s) => ({ ...s, [backend]: true }));
        setDraftKey((s) => ({ ...s, [backend]: '' }));
        setNote((s) => ({ ...s, [backend]: t('aiEngines.saved') }));
        // OpenAI key gates Talk — mirror presence to the store so the warning clears now.
        if (backend === 'openai') setHasOpenAiKey(true);
      } else setNote((s) => ({ ...s, [backend]: r.error ?? t('aiEngines.failed') }));
    } catch (e) { setNote((s) => ({ ...s, [backend]: e instanceof Error ? e.message : String(e) })); }
  };
  const clearKey = async (backend: string) => {
    try {
      await window.cth.providerKeyClear(backend);
      setHasKey((s) => ({ ...s, [backend]: false }));
      setNote((s) => ({ ...s, [backend]: t('aiEngines.cleared') }));
      // OpenAI key gates Talk — clearing it disables Talk; reflect that immediately.
      if (backend === 'openai') setHasOpenAiKey(false);
    } catch { /* noop */ }
  };

  const runProbe = async () => {
    setProbing(true); setProbe(null);
    try {
      const extra = probeExtra.trim() ? [probeExtra.trim()] : [];
      const r = await window.cth.openRouterProbe(extra);
      setProbe(r.ok ? { results: r.results } : { error: r.error });
    } catch (e) { setProbe({ error: e instanceof Error ? e.message : String(e) }); }
    finally { setProbing(false); }
  };

  /** Persist the tiers: a row with no model is "unset", which main drops. */
  const saveTiers = async (next: ModelTiers) => {
    setTiers(next);
    try {
      await window.cth.updateConfig({ modelTiers: next } as Partial<HarnessConfig>);
      setTierNote(t('aiEngines.tiersSaved'));
    } catch { setTierNote(t('aiEngines.failed')); }
  };
  const commitTier = (name: TierName, draft: { provider: string; model: string; effort: string; maxOutputTokens: string }) => {
    const tier = normalizeTier({ provider: draft.provider, model: draft.model, effort: draft.effort || undefined, maxOutputTokens: draft.maxOutputTokens ? Number(draft.maxOutputTokens) : undefined });
    const next: ModelTiers = { ...tiers };
    if (tier) next[name] = tier; else delete next[name];
    void saveTiers(next);
  };
  const setDraft = (name: TierName, patch: Partial<{ provider: string; model: string; effort: string; maxOutputTokens: string }>, commit = false) => {
    setTierDraft((d) => {
      const nd = { ...d, [name]: { ...d[name], ...patch } };
      if (commit) commitTier(name, nd[name]);
      return nd;
    });
  };
  const applyTiers = (next: ModelTiers) => {
    const d = { ...tierDraft };
    for (const n of TIER_NAMES) {
      const tt: ModelTier | undefined = next[n];
      d[n] = { provider: tt?.provider ?? 'opencode', model: tt?.model ?? '', effort: tt?.effort ?? '', maxOutputTokens: tt?.maxOutputTokens ? String(tt.maxOutputTokens) : '' };
    }
    setTierDraft(d);
    void saveTiers(next);
  };
  // Engines that take a --model flag are the ones a tier can name.
  const tierEngines = AGENT_PROVIDER_PRESETS.filter((p) => p.supportsModel && p.id !== 'custom');

  const saveBaseUrl = async (id: AgentProvider, value: string) => {
    const next = { ...baseUrls, [id]: value.trim() || undefined };
    setBaseUrls(next);
    try { await window.cth.updateConfig({ providerBaseUrls: next }); } catch { /* noop */ }
  };
  const saveModel = async (id: AgentProvider, value: string) => {
    const next = { ...models, [id]: value.trim() || undefined };
    setModels(next);
    try { await window.cth.updateConfig({ providerDefaultModels: next }); } catch { /* noop */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={headStyle}>{t('aiEngines.providers')}</div>
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
          {t('aiEngines.providersDesc')}
        </div>
      </div>

      {/* Backend API keys (write-only) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={headStyle}>{t('aiEngines.apiKeys')}</div>
        {BACKENDS.map((b) => (
          <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>
              {b.label} {hasKey[b.id] ? `· ${t('aiEngines.setCheck')}` : keySource[b.id] === 'env' ? `· ${t('aiEngines.setCheck')} · ${t('aiEngines.fromEnv', { envVar: b.envVar })}` : ''} <span style={{ opacity: 0.6 }}>({b.envVar})</span>
            </label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="password"
                autoComplete="off"
                placeholder={hasKey[b.id] ? t('aiEngines.keyStoredPlaceholder') : t('aiEngines.keyPlaceholder', { label: b.label })}
                value={draftKey[b.id] ?? ''}
                onChange={(e) => setDraftKey((s) => ({ ...s, [b.id]: e.target.value }))}
                style={inputStyle}
              />
              <PixelButton variant="secondary" size="sm" onClick={() => saveKey(b.id)}>{t('common.save')}</PixelButton>
              {hasKey[b.id] && (
                <PixelButton variant="secondary" size="sm" onClick={() => clearKey(b.id)}>{t('common.delete')}</PixelButton>
              )}
            </div>
            {note[b.id] && <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{note[b.id]}</div>}
            {b.id === 'openrouter' && (hasKey[b.id] || keySource[b.id] === 'env') && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <PixelButton variant="secondary" size="sm" onClick={() => void runProbe()} disabled={probing}>
                    {probing ? t('aiEngines.testing') : t('aiEngines.testConnection')}
                  </PixelButton>
                  <input
                    value={probeExtra}
                    onChange={(e) => setProbeExtra(e.target.value)}
                    placeholder={t('aiEngines.probeExtraPlaceholder')}
                    spellCheck={false}
                    style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}
                  />
                </div>
                <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', lineHeight: '15px' }}>{t('aiEngines.testHint')}</div>
                {probe?.error && <div style={{ fontSize: 12, color: '#6E1423' }}>{probe.error}</div>}
                {probe?.results && (
                  <table data-testid="openrouter-probe" style={{ borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--cth-font-mono)' }}>
                    <thead>
                      <tr style={{ textAlign: 'start', color: 'var(--cth-ink-500)' }}>
                        <th style={{ padding: '2px 6px', textAlign: 'start' }}>{t('aiEngines.probeModel')}</th>
                        <th style={{ padding: '2px 6px', textAlign: 'start' }}>{t('aiEngines.probeTokens')}</th>
                        <th style={{ padding: '2px 6px', textAlign: 'start' }}>{t('aiEngines.probeCost')}</th>
                        <th style={{ padding: '2px 6px', textAlign: 'start' }}>{t('aiEngines.probeTime')}</th>
                        <th style={{ padding: '2px 6px', textAlign: 'start' }}>{t('aiEngines.probeReply')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {probe.results.map((r) => (
                        <tr key={`${r.label}-${r.model}`} style={{ borderTop: '1px solid var(--cth-ink-300)' }}>
                          <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }} title={r.servedModel ?? r.model}>{r.label === r.model ? r.model : `${r.label} · ${r.model}`}</td>
                          <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.usage ? `${r.usage.promptTokens} / ${r.usage.completionTokens}${r.usage.reasoningTokens ? ` (${r.usage.reasoningTokens} reasoning)` : ''}` : '—'}</td>
                          <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.usage ? (r.usage.cost === null ? t('aiEngines.probeNoCost') : `$${r.usage.cost.toFixed(6)}`) : '—'}</td>
                          <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '—'}</td>
                          <td style={{ padding: '3px 6px', color: r.ok ? 'var(--cth-ink-900)' : '#6E1423', maxWidth: 360 }}>{r.ok ? r.text : r.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Model tiers — engine + model per kind of job (worker / routine). */}
      <div data-testid="model-tiers" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={headStyle}>{t('aiEngines.tiers')}</div>
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>{t('aiEngines.tiersDesc')}</div>
        {TIER_NAMES.map((name) => {
          const d = tierDraft[name];
          return (
            <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={labelStyle}>{name === 'worker' ? t('aiEngines.tierWorker') : t('aiEngines.tierRoutine')}{tiers[name] ? ` · ${t('aiEngines.setCheck')}` : ''}</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <select
                  aria-label={t('aiEngines.tierEngine')}
                  value={d.provider}
                  onChange={(e) => setDraft(name, { provider: e.target.value }, true)}
                  style={{ ...inputStyle, width: 'auto', minWidth: 130 }}
                >
                  {tierEngines.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <input
                  aria-label={t('aiEngines.tierModel')}
                  value={d.model}
                  onChange={(e) => setDraft(name, { model: e.target.value })}
                  onBlur={() => commitTier(name, tierDraft[name])}
                  placeholder={t('aiEngines.tierModelPlaceholder')}
                  spellCheck={false}
                  style={{ ...inputStyle, flex: '1 1 260px', fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}
                />
                <select
                  aria-label={t('aiEngines.tierEffort')}
                  value={d.effort}
                  onChange={(e) => setDraft(name, { effort: e.target.value }, true)}
                  style={{ ...inputStyle, width: 'auto', minWidth: 120 }}
                >
                  <option value="">{t('aiEngines.tierEffortDefault')}</option>
                  {REASONING_EFFORTS.map((ef) => <option key={ef} value={ef}>{ef}</option>)}
                </select>
                <input
                  aria-label={t('aiEngines.tierMaxOut')}
                  type="number" min={256} step={1000}
                  value={d.maxOutputTokens}
                  onChange={(e) => setDraft(name, { maxOutputTokens: e.target.value })}
                  onBlur={() => commitTier(name, tierDraft[name])}
                  placeholder={t('aiEngines.tierMaxOut')}
                  style={{ ...inputStyle, width: 120 }}
                />
              </div>
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <PixelButton variant="secondary" size="sm" title={t('aiEngines.useSuggestedTitle')} onClick={() => applyTiers({ ...SUGGESTED_TIERS })}>{t('aiEngines.useSuggested')}</PixelButton>
          {(tiers.worker || tiers.routine) && (
            <PixelButton variant="secondary" size="sm" onClick={() => applyTiers({})}>{t('aiEngines.clearTiers')}</PixelButton>
          )}
          {tierNote && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{tierNote}</span>}
        </div>
      </div>

      {/* Per-CLI local endpoint + default model */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={headStyle}>{t('aiEngines.localEndpoint')}</div>
        {CLIS.map((c) => (
          <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ProviderLogo provider={c.id} size={12} /> {c.label}
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder={`base-URL — ${c.hint}`}
                defaultValue={baseUrls[c.id] ?? ''}
                onBlur={(e) => saveBaseUrl(c.id, e.target.value)}
                style={inputStyle}
              />
              <input
                placeholder={t('aiEngines.defaultModelPlaceholder')}
                defaultValue={models[c.id] ?? ''}
                onBlur={(e) => saveModel(c.id, e.target.value)}
                style={{ ...inputStyle, maxWidth: 220 }}
              />
            </div>
          </div>
        ))}
        {/* Local-setup guides (ondev-c part-3) — link the two how-to blogs. */}
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
          {t('aiEngines.runningOpenModels')}{' '}
          <a
            href={OSS_BLOG_LINKS.openModels}
            onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.openModels); }}
            style={linkStyle}
          >{t('aiEngines.runOnOpenModels')}</a>
          {' '}·{' '}
          <a
            href={OSS_BLOG_LINKS.macMini}
            onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.macMini); }}
            style={linkStyle}
          >{t('aiEngines.setUpMacMini')}</a>.
        </div>
      </div>

      {/* Unsandboxed-in-auto caveat (Pam guardrail #6) */}
      <div style={{
        fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px',
        padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', background: 'var(--cth-paper-100)'
      }}>
        {t('aiEngines.autoModeCaveat')}
      </div>
    </div>
  );
}
