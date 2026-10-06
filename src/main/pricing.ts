/**
 * Fallback-only model → price table (USD per million tokens).
 *
 * The LIVE telemetry path does NOT use this. Claude Code emits a pre-computed,
 * per-model `cost_usd` on every `api_request` log and a `claude_code.cost.usage`
 * metric (verified by the 7A.1 spike), so the collector (`telemetry.ts`) trusts
 * Claude's own figure. This table exists solely for the OFFLINE transcript
 * reconciler (`transcript.ts`), which runs when telemetry is off and must
 * estimate cost from raw token counts.
 *
 * It supersedes the old hard-coded Sonnet-for-everyone constants that lived in
 * `transcript.ts` (cost bug #1 — Opus undercosted ~5×, Haiku overcosted). Prices
 * are now matched per model family. This is the ONE place per-model pricing
 * lives; both the transcript backend and the collector's fallback import it.
 */

/** USD per million tokens for one model family. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
  /** Some models re-price the WHOLE request once its input passes a line
   *  (GPT-6.1 Sol: 272k → 2× input and cache, 1.5× output). */
  longContext?: { thresholdTokens: number; inputMult: number; outputMult: number };
  /** The rate depends on which upstream a router picks per call (OpenRouter's
   *  DeepSeek routes span a 3× range), so a figure from this row is an
   *  estimate. Exact costs come from the provider's own usage report. */
  variable?: boolean;
}

// Anthropic list prices, USD per million tokens. Approximate, fallback-only —
// the live path uses Claude's own per-model cost, so drift here is harmless.
const OPUS: ModelPrice = { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 };
const SONNET: ModelPrice = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 };
const HAIKU: ModelPrice = { inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1.0 };

/** A Claude id we do not recognise is priced as Sonnet (the historical
 *  default). Any OTHER unknown model is priced at zero and flagged, so a cheap
 *  engine is never silently billed at Claude rates. */
const DEFAULT_CLAUDE_PRICE: ModelPrice = SONNET;
const FREE: ModelPrice = { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };

const P = (inputPerM: number, outputPerM: number, cacheReadPerM = inputPerM / 10, cacheWritePerM = inputPerM * 1.25): ModelPrice =>
  ({ inputPerM, outputPerM, cacheReadPerM, cacheWritePerM });

/** Non-Claude list prices, USD per million tokens, matched by substring of the
 *  normalized id with provider prefixes stripped. Approximate: these are the
 *  published rates at the time of writing and the owner can override any of
 *  them in Settings (modelPriceOverrides). First match wins, so the more
 *  specific entries come first. */
/** GPT-6.1 Sol on OpenRouter: $2 in, $10 out, $0.10 cached read, $2.50 cache
 *  write; past 272k input tokens the whole request bills 2× in / 1.5× out. The
 *  Pro variant costs the same per token and spends several times more reasoning
 *  tokens per request, which is why the suggested tiers never pick it. */
const GPT61_SOL: ModelPrice = {
  ...P(2.00, 10.00, 0.10, 2.50),
  longContext: { thresholdTokens: 272_000, inputMult: 2, outputMult: 1.5 }
};

const OTHER_PRICES: Array<[RegExp, ModelPrice]> = [
  // OpenAI GPT-6.1 Sol (OpenRouter). Both ids share one row; see GPT61_SOL.
  [/gpt-6\.1-sol/, GPT61_SOL],
  // DeepSeek (OpenRouter / direct). V4.1 Flash's rate depends on the upstream
  // OpenRouter routes to (about $0.05–0.15 in, $0.31–0.60 out); DeepSeek's own
  // list price is the conservative figure here, flagged variable.
  [/deepseek-v4\.1-flash|deepseek-v4-1-flash/, { ...P(0.15, 0.60, 0.015), variable: true }],
  [/deepseek-v4-flash/, P(0.0152, 1.28, 0.0015)],
  [/deepseek-v4-pro|deepseek-v4$/, P(0.19, 4.20, 0.019)],
  [/deepseek-r1/, P(0.55, 2.19, 0.14)],
  [/deepseek-chat|deepseek-v3/, P(0.27, 1.10, 0.07)],
  // Qwen
  [/qwen3-coder-plus|qwen3-coder-480b|qwen3-coder$/, P(0.30, 1.20)],
  [/qwen3-235b/, P(0.13, 0.60)],
  [/qwen3-coder:30b|qwen3-coder-30b|qwen3[:-]30b|qwen3[:-]8b|qwen3[:-]4b/, FREE],
  // Meta / open weights on Groq and OpenRouter
  [/llama-3\.3-70b|llama3\.3/, P(0.59, 0.79)],
  [/llama-4-maverick/, P(0.15, 0.60)],
  [/llama-4-scout/, P(0.08, 0.30)],
  [/gpt-oss-120b|gpt-oss:120b/, P(0.15, 0.60)],
  [/gpt-oss-20b|gpt-oss:20b/, P(0.05, 0.20)],
  // Moonshot, Zhipu, Mistral
  [/kimi-k2/, P(0.60, 2.50)],
  [/glm-4\.[67]|glm-5/, P(0.60, 2.20)],
  [/mistral-small/, P(0.10, 0.30)],
  [/mistral-large|mistral-medium/, P(0.40, 2.00)],
  // Google
  [/gemini-2\.5-flash-lite|flash-lite/, P(0.10, 0.40)],
  [/gemini-2\.5-flash|gemini-3[.-].*flash|^flash$/, P(0.30, 2.50)],
  [/gemini-2\.5-pro|gemini-3[.-].*pro|^pro$/, P(1.25, 10.00)],
  // OpenAI
  [/gpt-5-nano/, P(0.05, 0.40)],
  [/gpt-5-mini/, P(0.25, 2.00)],
  [/gpt-5/, P(1.25, 10.00)],
  [/gpt-4o-mini/, P(0.15, 0.60)],
  [/gpt-4o/, P(2.50, 10.00)],
  [/gpt-4\.1-mini/, P(0.40, 1.60)],
  [/gpt-4\.1/, P(2.00, 8.00)],
  [/o3-mini|o4-mini/, P(1.10, 4.40)],
  [/^o3/, P(2.00, 8.00)],
  [/codex/, P(1.50, 6.00)]
];

export interface PriceInfo {
  price: ModelPrice;
  /** False when no row matched: the price is a placeholder, not a fact. */
  known: boolean;
  /** Runs on this machine (Ollama / LM Studio): no per-token charge. */
  local: boolean;
  /** An Anthropic model. */
  claude: boolean;
  /** The row is a per-call-varying estimate (see ModelPrice.variable). */
  variable: boolean;
}

/** Owner overrides from Settings: one per line, `model-id input output [cacheRead cacheWrite]`
 *  in USD per million. Matched by substring like the built-in table. */
export function parsePriceOverrides(text: string | undefined | null): Array<[string, ModelPrice]> {
  const out: Array<[string, ModelPrice]> = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) continue;
    const [id, i, o, cr, cw] = parts;
    const inputPerM = Number(i), outputPerM = Number(o);
    if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM)) continue;
    const cacheReadPerM = Number.isFinite(Number(cr)) && cr !== undefined ? Number(cr) : inputPerM / 10;
    const cacheWritePerM = Number.isFinite(Number(cw)) && cw !== undefined ? Number(cw) : inputPerM * 1.25;
    out.push([id.toLowerCase(), { inputPerM, outputPerM, cacheReadPerM, cacheWritePerM }]);
  }
  return out;
}

let overrides: Array<[string, ModelPrice]> = [];
/** Install the owner's overrides (called whenever config changes). */
export function setPriceOverrides(text: string | undefined | null): void {
  overrides = parsePriceOverrides(text);
}

/** Strip a routing prefix (`openrouter/`, `groq/`, `google/`, `local/`, `ollama/`…). */
function bareModel(m: string): string {
  const parts = m.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : m;
}

/** Everything known about a model's price. */
export function priceInfo(model: string | undefined | null): PriceInfo {
  const norm = normalizeModel(model).toLowerCase();
  const claude = norm.includes('claude') || norm.includes('opus') || norm.includes('sonnet') || norm.includes('haiku');
  const local = /^(local|ollama|lmstudio|lm-studio)\//.test(norm) || norm.includes('localhost');
  for (const [id, price] of overrides) {
    if (norm.includes(id)) return { price, known: true, local, claude, variable: false };
  }
  if (local) return { price: FREE, known: true, local: true, claude: false, variable: false };
  if (claude) {
    if (norm.includes('opus')) return { price: OPUS, known: true, local: false, claude: true, variable: false };
    if (norm.includes('haiku')) return { price: HAIKU, known: true, local: false, claude: true, variable: false };
    if (norm.includes('sonnet')) return { price: SONNET, known: true, local: false, claude: true, variable: false };
    return { price: DEFAULT_CLAUDE_PRICE, known: false, local: false, claude: true, variable: false };
  }
  const bare = bareModel(norm);
  for (const [re, price] of OTHER_PRICES) {
    if (re.test(bare) || re.test(norm)) return { price, known: true, local: false, claude: false, variable: price.variable === true };
  }
  return { price: FREE, known: false, local: false, claude: false, variable: false };
}

/** USD for one request's tokens at a price row, long-context rule included:
 *  the rule keys on the request's whole input (fresh + cached + newly cached),
 *  which is what the provider counts against the line. */
export function costFromPrice(p: ModelPrice, tokens: TokenSplit): number {
  let inMult = 1, outMult = 1;
  const lc = p.longContext;
  if (lc && tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens > lc.thresholdTokens) {
    inMult = lc.inputMult; outMult = lc.outputMult;
  }
  return (
    (tokens.inputTokens / 1_000_000) * p.inputPerM * inMult +
    (tokens.outputTokens / 1_000_000) * p.outputPerM * outMult +
    (tokens.cacheReadTokens / 1_000_000) * p.cacheReadPerM * inMult +
    (tokens.cacheWriteTokens / 1_000_000) * p.cacheWritePerM * inMult
  );
}

/**
 * Strip Claude Code's variant suffix so `claude-opus-4-8[1m]` (the form the
 * `token.usage` metric carries) and `claude-opus-4-8` (the base id the
 * `api_request` log carries) resolve to the same family. Case is preserved;
 * matching is done case-insensitively in `priceFor`.
 */
export function normalizeModel(model: string | undefined | null): string {
  return (model ?? '').trim().replace(/\[[^\]]*\]\s*$/, '');
}

/** Resolve a model id to its price row. An unrecognised Claude id falls back
 *  to Sonnet; an unrecognised other model prices at zero (see priceInfo). */
export function priceFor(model: string | undefined | null): ModelPrice {
  return priceInfo(model).price;
}

/** Token split used by the cost estimator (matches `AgentUsage` token fields). */
export interface TokenSplit {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Estimate USD cost for a token split using the model's fallback price row.
 * Used only by the transcript reconciler; the live path trusts Claude's cost.
 */
export function estimateCostUsd(model: string | undefined | null, tokens: TokenSplit): number {
  return costFromPrice(priceFor(model), tokens);
}
