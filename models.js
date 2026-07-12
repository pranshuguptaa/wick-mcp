/**
 * Wick MCP — model pricing + burn-rate data.
 *
 * inputCost / outputCost are USD per **million** tokens.
 * burn is the multiplier relative to the Haiku baseline (Haiku = 1.0).
 * Cache reads are billed at 10% of the input price (Anthropic prompt caching).
 */

export const USD_TO_INR = 84;

// A cache read costs 10% of the normal input token price.
const CACHE_READ_RATE = 0.1;

export const MODELS = {
  'claude-opus-4-8':   { inputCost: 15,  outputCost: 75, burn: 5.0, label: 'Opus 4.8'   },
  'claude-opus-4-7':   { inputCost: 15,  outputCost: 75, burn: 5.0, label: 'Opus 4.7'   },
  'claude-opus-4-6':   { inputCost: 15,  outputCost: 75, burn: 5.0, label: 'Opus 4.6'   },
  'claude-sonnet-4-6': { inputCost: 3,   outputCost: 15, burn: 2.0, label: 'Sonnet 4.6' },
  'claude-haiku-4-5':  { inputCost: 0.8, outputCost: 4,  burn: 1.0, label: 'Haiku 4.5'  },
};

// Sensible default when nothing matches.
const DEFAULT_KEY = 'claude-sonnet-4-6';

/**
 * Fuzzy-match a model string to a MODELS key.
 * Handles exact ids, partial ids, and bare family names ("opus", "sonnet").
 * Returns { key, ...modelData }.
 */
export function resolveModel(model) {
  const q = String(model || '').toLowerCase().trim();

  // 1. exact key
  if (MODELS[q]) return { key: q, ...MODELS[q] };

  // 2. substring either direction (e.g. "opus-4-8" or "claude-opus-4-8-2025xx")
  for (const key of Object.keys(MODELS)) {
    if (q && (key.includes(q) || q.includes(key))) return { key, ...MODELS[key] };
  }

  // 3. family word → first matching model in that family
  for (const family of ['opus', 'sonnet', 'haiku']) {
    if (q.includes(family)) {
      const key = Object.keys(MODELS).find((k) => k.includes(family));
      if (key) return { key, ...MODELS[key] };
    }
  }

  // 4. default
  return { key: DEFAULT_KEY, ...MODELS[DEFAULT_KEY] };
}

/**
 * Compute cost for a single turn.
 * @returns {{ model, label, inputCost, outputCost, cacheReadCost,
 *             cacheSavings, totalCostUSD, totalCostINR }}
 */
export function getCost(model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0) {
  const m = resolveModel(model);
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  const cacheTok = Number(cacheReadTokens) || 0;

  const inputCost = (inTok / 1e6) * m.inputCost;
  const outputCost = (outTok / 1e6) * m.outputCost;
  const cacheReadCost = (cacheTok / 1e6) * m.inputCost * CACHE_READ_RATE;
  // savings = what those cached tokens would have cost at full input price,
  // minus what they actually cost at the cache rate.
  const cacheSavings = (cacheTok / 1e6) * m.inputCost * (1 - CACHE_READ_RATE);

  const totalCostUSD = inputCost + outputCost + cacheReadCost;
  const totalCostINR = totalCostUSD * USD_TO_INR;

  return {
    model: m.key,
    label: m.label,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheSavings,
    totalCostUSD,
    totalCostINR,
  };
}

/**
 * Estimate how many messages remain in the current 5-hour window.
 * Baseline: Haiku ~50 messages / session; capacity scales down by burn
 * multiplier (Opus 5.0 → ~10). We subtract an estimate of messages already
 * used, derived from tokens-used ÷ avg-tokens-per-turn.
 */
export function estimateMessagesLeft(model, tokensUsedThisSession = 0, avgTokensPerTurn = 0) {
  const m = resolveModel(model);
  const capacity = 50 / (m.burn || 1); // Haiku 50, Sonnet 25, Opus 10
  const used =
    avgTokensPerTurn > 0 ? (Number(tokensUsedThisSession) || 0) / avgTokensPerTurn : 0;
  return Math.max(0, Math.floor(capacity - used));
}

/**
 * Fraction (0–1) of the 5-hour session window estimated to be consumed.
 */
export function sessionFraction(model, tokensUsedThisSession = 0, avgTokensPerTurn = 0) {
  const m = resolveModel(model);
  const capacity = 50 / (m.burn || 1);
  const used =
    avgTokensPerTurn > 0 ? (Number(tokensUsedThisSession) || 0) / avgTokensPerTurn : 0;
  return Math.max(0, Math.min(1, used / capacity));
}
