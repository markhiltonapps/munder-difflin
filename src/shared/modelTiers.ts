/**
 * Model tiers — which engine + model does which KIND of job.
 *
 * The owner pays per finished task, not per token, so the choice that matters
 * is "what runs the routine work and what runs the real work". Two tiers carry
 * that choice as SETTINGS (never code):
 *
 *   worker  — implementation, debugging, anything that has to be right.
 *   routine — triage, formatting, summaries, lookups, verification passes.
 *
 * The manager (Michael) keeps his own existing setting (godProvider/godModel).
 *
 * A tier names the ENGINE (the CLI the agent runs in), the MODEL slug the engine
 * takes on its --model flag, the reasoning EFFORT the engine should ask for, and
 * a MAX OUTPUT budget. Unset tiers mean "behave exactly as before this existed".
 *
 * Pure + dependency-free: shared by main (spawn, config, prompt), the renderer
 * (Settings, Hire dialog) and the tests.
 */
import type { AgentProvider } from './agentProvider';
import { normalizeAgentProvider } from './agentProvider';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type TierName = 'worker' | 'routine';
export const TIER_NAMES: TierName[] = ['worker', 'routine'];

export interface ModelTier {
  provider: AgentProvider;
  /** The exact --model value for that engine, e.g. `openrouter/openai/gpt-6.1-sol`. */
  model: string;
  effort?: ReasoningEffort;
  /** Output budget per response. The engine applies it where it can. */
  maxOutputTokens?: number;
}

export type ModelTiers = Partial<Record<TierName, ModelTier>>;

/** OpenRouter's OpenAI-compatible base. The one URL every engine is pointed at. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_HOST = 'openrouter.ai';
/** The slug prefix the OpenCode/Crush/pi engines use for OpenRouter routing. */
export const OPENROUTER_PREFIX = 'openrouter/';

/** GPT-6.1 Sol bills the WHOLE request at the long-context rate past this many
 *  input tokens, so it is the usable window, not the model's nominal one. */
export const GPT61_SOL_CONTEXT_BUDGET = 272_000;

/** The setup the plan recommends. Offered as a one-click fill in Settings, never
 *  applied on its own: an unset tier keeps today's behaviour. */
export const SUGGESTED_TIERS: Required<ModelTiers> = {
  worker: { provider: 'opencode', model: 'openrouter/openai/gpt-6.1-sol', effort: 'high', maxOutputTokens: 32_000 },
  routine: { provider: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash', effort: 'low', maxOutputTokens: 8_000 }
};

export function normalizeEffort(v: unknown): ReasoningEffort | undefined {
  return typeof v === 'string' && (REASONING_EFFORTS as string[]).includes(v) ? (v as ReasoningEffort) : undefined;
}

/** A tier read back from config or a settings form: a provider the app knows and
 *  a non-empty model, or nothing. Garbage never reaches a command line. */
export function normalizeTier(v: unknown): ModelTier | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const provider = normalizeAgentProvider(o.provider);
  const model = typeof o.model === 'string' ? o.model.trim() : '';
  if (!provider || !model || model.length > 120 || /[\s"'`$;&|<>]/.test(model)) return undefined;
  const effort = normalizeEffort(o.effort);
  const max = Number(o.maxOutputTokens);
  const maxOutputTokens = Number.isFinite(max) && max >= 256 && max <= 400_000 ? Math.round(max) : undefined;
  return { provider, model, ...(effort ? { effort } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}) };
}

export function normalizeTiers(v: unknown): ModelTiers {
  const out: ModelTiers = {};
  if (!v || typeof v !== 'object') return out;
  for (const name of TIER_NAMES) {
    const t = normalizeTier((v as Record<string, unknown>)[name]);
    if (t) out[name] = t;
  }
  return out;
}

/** Which tier a role belongs to. Mirrors the Haiku-for-helpers rule the app has
 *  always applied: narrow, mechanical roles are routine work. */
export function tierForRole(role?: string | null, capabilities?: string[] | null): TierName {
  const hay = `${role ?? ''} ${(capabilities ?? []).join(' ')}`.toLowerCase();
  return /\b(triage|rout|verif|lint|format|summar|classif|label)/.test(hay) ? 'routine' : 'worker';
}

export function normalizeTierName(v: unknown): TierName | undefined {
  return v === 'worker' || v === 'routine' ? v : undefined;
}

/** The tier whose engine + model an agent is actually running, if any — so the
 *  spawn can hand the engine that tier's effort and output budget. */
export function tierMatching(tiers: ModelTiers | undefined, provider: AgentProvider | undefined, model: string | undefined | null): ModelTier | undefined {
  if (!tiers || !provider || !model) return undefined;
  const m = model.trim().toLowerCase();
  for (const name of TIER_NAMES) {
    const t = tiers[name];
    if (t && t.provider === provider && t.model.toLowerCase() === m) return t;
  }
  return undefined;
}

export function isOpenRouterModel(model: string | undefined | null): boolean {
  return typeof model === 'string' && model.trim().toLowerCase().startsWith(OPENROUTER_PREFIX);
}

/** `openrouter/openai/gpt-6.1-sol` → `openai/gpt-6.1-sol`: what OpenRouter itself
 *  calls the model, for engines that talk to it over a plain base URL. */
export function openRouterModelId(model: string): string {
  const m = model.trim();
  return isOpenRouterModel(m) ? m.slice(OPENROUTER_PREFIX.length) : m;
}

export function isOpenRouterUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try { return new URL(url).hostname.toLowerCase() === OPENROUTER_HOST; } catch { return false; }
}

/** Context windows the app knows well enough to hand an engine as its compaction
 *  limit. Only entries where the number is a billing or hard boundary, never a
 *  guess: a wrong limit here would compact too early or too late. */
export function knownContextBudget(model: string | undefined | null): number | undefined {
  const m = (model ?? '').toLowerCase();
  if (m.includes('gpt-6.1-sol')) return GPT61_SOL_CONTEXT_BUDGET;
  return undefined;
}
