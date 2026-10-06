/**
 * OpenRouter — the one place the app itself talks to openrouter.ai.
 *
 * Agents reach OpenRouter through their own engines (OpenCode's built-in
 * provider, Qwen Code over the loopback proxy). This module exists for the
 * owner's "Test connection" button in Settings: a short real call per model
 * tier that returns the exact token counts and the DOLLAR COST OpenRouter
 * itself reports, so the owner sees what a job costs before any agent runs.
 *
 * Rules, same as every other key-bearing module here:
 *   - the key is an argument, used ONLY in the Authorization header, never
 *     logged and never part of a result (error text is scrubbed too);
 *   - no electron import, so it unit-tests as a plain Node module;
 *   - bounded: one request at a time, a hard timeout, a tiny output cap.
 */
import { OPENROUTER_BASE_URL, type ReasoningEffort } from '../shared/modelTiers';

export const OPENROUTER_CHAT_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
const REQUEST_TIMEOUT_MS = 45_000;
/** The probe asks for one short sentence. 60 tokens of output is plenty and a
 *  reasoning model that ignores the cap still cannot run away on us. */
const PROBE_MAX_TOKENS = 60;
const PROBE_PROMPT = 'Reply with one short sentence: what model are you, and what is 17 times 23?';

export interface ProbeSpec {
  /** What the row is called in Settings ("worker", "routine", or a model id). */
  label: string;
  /** OpenRouter's own id, e.g. `openai/gpt-6.1-sol` (no `openrouter/` prefix). */
  model: string;
  effort?: ReasoningEffort;
}

export interface OpenRouterUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** USD charged for the call, as OpenRouter reports it; null when absent. */
  cost: number | null;
}

export interface ProbeResult {
  label: string;
  model: string;
  ok: boolean;
  /** Wall time of the call. */
  ms: number;
  /** The model's reply, trimmed. */
  text?: string;
  /** The model id the response carried (OpenRouter may resolve aliases). */
  servedModel?: string;
  usage?: OpenRouterUsage;
  error?: string;
}

/** The request body for one probe. Pure, so the tests can pin its shape: usage
 *  accounting ON (that is where the cost comes from), the effort the tier asks
 *  for, and a small output cap. */
export function buildProbeBody(spec: ProbeSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    max_tokens: PROBE_MAX_TOKENS,
    usage: { include: true }
  };
  if (spec.effort) body.reasoning = { effort: spec.effort };
  return body;
}

/** Pull the usage block out of an OpenRouter chat response. Field names follow
 *  OpenRouter's usage-accounting shape; anything missing reads as 0 / null. */
export function parseUsage(json: unknown): OpenRouterUsage | undefined {
  const u = (json as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const pd = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cd = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    promptTokens: n(u.prompt_tokens),
    completionTokens: n(u.completion_tokens),
    cachedTokens: n(pd.cached_tokens),
    cacheWriteTokens: n(pd.cache_write_tokens),
    reasoningTokens: n(cd.reasoning_tokens),
    cost: typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null
  };
}

/** Error text that is safe to show: no key material, bounded length. */
export function scrubError(text: string, apiKey: string): string {
  let t = String(text ?? '');
  if (apiKey) t = t.split(apiKey).join('[key]');
  t = t.replace(/sk-or-[A-Za-z0-9_-]+/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]');
  return t.replace(/\s+/g, ' ').trim().slice(0, 240);
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean; status: number; text(): Promise<string>;
}>;

/** One real call. Never throws; never logs; the key is not in the result. */
export async function probeOne(apiKey: string, spec: ProbeSpec, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ProbeResult> {
  const started = Date.now();
  const base = { label: spec.label, model: spec.model };
  if (!apiKey) return { ...base, ok: false, ms: 0, error: 'no OpenRouter key set' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter attributes traffic by these; no key material, just a name.
        'HTTP-Referer': 'https://munderdiffl.in',
        'X-Title': 'Munder Difflin'
      },
      body: JSON.stringify(buildProbeBody(spec)),
      signal: controller.signal
    });
    const raw = await res.text();
    const ms = Date.now() - started;
    let json: unknown = null;
    try { json = JSON.parse(raw); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } } | null)?.error?.message;
      return { ...base, ok: false, ms, error: scrubError(`HTTP ${res.status}${msg ? `: ${msg}` : raw ? `: ${raw}` : ''}`, apiKey) };
    }
    const j = json as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } } | null;
    if (j?.error?.message) return { ...base, ok: false, ms, error: scrubError(j.error.message, apiKey) };
    const content = j?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content.trim().slice(0, 300)
      : Array.isArray(content) ? content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('').trim().slice(0, 300)
        : '';
    return {
      ...base, ok: true, ms, text,
      servedModel: typeof j?.model === 'string' ? j.model : undefined,
      usage: parseUsage(json)
    };
  } catch (e) {
    const aborted = controller.signal.aborted;
    return { ...base, ok: false, ms: Date.now() - started, error: aborted ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : scrubError(e instanceof Error ? e.message : String(e), apiKey) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe several models one after another (never in parallel: the point is a
 *  tiny, readable spend, not a load test). */
export async function probeOpenRouter(apiKey: string, specs: ProbeSpec[], fetchImpl?: FetchLike): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const spec of specs.slice(0, 6)) out.push(await probeOne(apiKey, spec, fetchImpl));
  return out;
}
