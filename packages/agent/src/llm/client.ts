/**
 * Multi-provider LLM reasoning client with key failover.
 *
 * Reads multiple Gemini keys (GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3)
 * and Groq keys (GROQ_API_KEY, GROQ_API_KEY_2). Tries each in order; on auth/5xx/timeout
 * fails over to the next. If all keys fail, returns null so the pipeline uses
 * the documented deterministic fallback (labeled as such).
 *
 * The LLM is a *reasoning/explanation* layer — it proposes diagnoses and
 * recommendations but NEVER controls money. The DecisionEngine and executor
 * remain authoritative.
 */
import { FailureCategory, ALL_FAILURE_CATEGORIES, InterventionType } from '../../../domain/src';
import type { RecoveryFeatures } from '../../../domain/src';

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

interface ProviderConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * Collect all available API keys from environment variables.
 * Keys are tried in order; on failure the next one is attempted.
 */
function collectProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  // Gemini keys (OpenAI-compatible endpoint)
  const geminiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].filter(Boolean);
  for (const key of geminiKeys) {
    providers.push({
      name: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.0-flash',
      apiKey: key!,
    });
  }

  // Groq keys (OpenAI-compatible endpoint)
  const groqKeys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
  ].filter(Boolean);
  for (const key of groqKeys) {
    providers.push({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-8b-instant',
      apiKey: key!,
    });
  }

  return providers;
}

// ---------------------------------------------------------------------------
// Structured output contract
// ---------------------------------------------------------------------------

export interface LLMReasoningOutput {
  /** AI-classified failure category (must be one of the known categories). */
  diagnosis: {
    category: string;
    confidence: number;
    evidence: string[];
  };
  /** Proposed recovery action (must be one of the known intervention types). */
  recommendedAction: string;
  /** Human-readable rationale for the recommendation. */
  rationale: string;
  /** Key factors that influenced the recommendation. */
  keyFactors: string[];
}

export interface LLMCallResult {
  /** The provider that successfully responded. */
  provider: string;
  /** The model that generated the response. */
  model: string;
  /** The structured reasoning output. */
  output: LLMReasoningOutput;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a payment recovery AI agent. You analyze failed payment data and recommend recovery actions.

You MUST respond with valid JSON only — no markdown, no explanation outside the JSON.

Output schema:
{
  "diagnosis": {
    "category": "<one of the allowed categories>",
    "confidence": <0.0-1.0>,
    "evidence": ["<factor1>", "<factor2>"]
  },
  "recommendedAction": "<one of the allowed actions>",
  "rationale": "<2-3 sentence explanation>",
  "keyFactors": ["<factor1>", "<factor2>", "<factor3>"]
}

ALLOWED failure categories:
${ALL_FAILURE_CATEGORIES.join(', ')}

ALLOWED recovery actions:
${Object.values(InterventionType).join(', ')}

Rules:
- confidence must be between 0.0 and 1.0
- recommendedAction must be one of the allowed action types exactly
- category must be one of the allowed category strings exactly
- rationale should be concise (2-3 sentences max)
- keyFactors should be the 2-4 most important signals
- You do NOT execute actions — you only recommend. The policy engine makes the final decision.`;

function buildUserPrompt(context: {
  features: RecoveryFeatures;
  mlProbability: number;
  mlConfidence: number;
  modelVersion: string;
  failureMessage?: string;
  merchantPolicy?: {
    maxRetries: number;
    maxRetryDelayMs: number;
    approvalThreshold: number;
    maxIncentive: number;
  };
}): string {
  const f = context.features;
  const amountInr = (f.amount / 100).toLocaleString('en-IN');
  const mlPct = (context.mlProbability * 100).toFixed(1);

  return `Analyze this failed payment and recommend the best recovery action.

PAYMENT CONTEXT:
- Amount: ₹${amountInr} (${f.amount} paise)
- Failure category: ${f.failureCategory}
- Payment method: ${f.paymentMethod}
- Retry count: ${f.retryCount}
- Time since failure: ${f.timeSinceFailureHours}h
- Transaction hour: ${f.transactionHour}:00
- Is subscription: ${f.isSubscription}
- Customer historical recovery rate: ${(f.historicalSuccessRate * 100).toFixed(0)}%
- Merchant historical recovery rate: ${(f.merchantHistoricalRate * 100).toFixed(0)}%
- Failure category recovery rate: ${(f.failureCategoryHistoricalRate * 100).toFixed(0)}%
- Amount percentile: ${(f.amountPercentile * 100).toFixed(0)}th

ML MODEL PREDICTION:
- Recovery probability: ${mlPct}%
- Model confidence: ${(context.mlConfidence * 100).toFixed(0)}%
- Model version: ${context.modelVersion}

${context.failureMessage ? `FAILURE MESSAGE: ${context.failureMessage}` : ''}

${context.merchantPolicy ? `MERCHANT POLICY:
- Max retries: ${context.merchantPolicy.maxRetries}
- Approval threshold: ₹${(context.merchantPolicy.approvalThreshold / 100).toLocaleString('en-IN')}
- Max incentive: ₹${(context.merchantPolicy.maxIncentive / 100).toLocaleString('en-IN')}` : 'MERCHANT POLICY: default limits apply.'}

Recommend the best recovery action. Consider: is the probability high enough? Is the amount worth the effort? Has the customer already been contacted too many times? Is this a transient or permanent failure?`;
}

// ---------------------------------------------------------------------------
// API call with provider failover
// ---------------------------------------------------------------------------

async function callProvider(
  provider: ProviderConfig,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 15000,
): Promise<{ content: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Auth error or rate limit — fail over immediately
      console.warn(`[llm] ${provider.name} ${provider.model} returned ${res.status}`);
      return null;
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') return null;
    return { content };
  } catch (err: any) {
    // Timeout, network error, etc.
    console.warn(`[llm] ${provider.name} ${provider.model} failed:`, err?.message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set(ALL_FAILURE_CATEGORIES);
const VALID_ACTIONS = new Set(Object.values(InterventionType));

function validateAndNormalize(raw: any): LLMReasoningOutput | null {
  if (!raw || typeof raw !== 'object') return null;

  const { diagnosis, recommendedAction, rationale, keyFactors } = raw;

  // Validate diagnosis
  if (!diagnosis || typeof diagnosis !== 'object') return null;
  const category = String(diagnosis.category || '').toLowerCase().replace(/ /g, '_');
  if (!VALID_CATEGORIES.has(category as FailureCategory)) return null;
  const confidence = Number(diagnosis.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const evidence = Array.isArray(diagnosis.evidence)
    ? diagnosis.evidence.filter((e: any) => typeof e === 'string').slice(0, 5)
    : [];

  // Validate action
  const action = String(recommendedAction || '').toLowerCase().replace(/ /g, '_');
  if (!VALID_ACTIONS.has(action as InterventionType)) return null;

  // Rationale is free-form but must be a string
  const rationaleText = typeof rationale === 'string' ? rationale.slice(0, 1000) : '';

  // Key factors
  const factors = Array.isArray(keyFactors)
    ? keyFactors.filter((f: any) => typeof f === 'string').slice(0, 5)
    : [];

  return {
    diagnosis: { category, confidence, evidence },
    recommendedAction: action,
    rationale: rationaleText,
    keyFactors: factors,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call the LLM to produce structured reasoning for a recovery case.
 * Tries all configured providers in order. Returns null if all fail.
 */
export async function callLLMReasoning(context: {
  features: RecoveryFeatures;
  mlProbability: number;
  mlConfidence: number;
  modelVersion: string;
  failureMessage?: string;
  merchantPolicy?: {
    maxRetries: number;
    maxRetryDelayMs: number;
    approvalThreshold: number;
    maxIncentive: number;
  };
}): Promise<LLMCallResult | null> {
  const providers = collectProviders();
  if (providers.length === 0) return null;

  const systemPrompt = SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(context);

  for (const provider of providers) {
    const result = await callProvider(provider, systemPrompt, userPrompt);
    if (!result) continue;

    try {
      const parsed = JSON.parse(result.content);
      const validated = validateAndNormalize(parsed);
      if (!validated) {
        console.warn(`[llm] ${provider.name} response failed validation`);
        continue;
      }
      return { provider: provider.name, model: provider.model, output: validated };
    } catch {
      console.warn(`[llm] ${provider.name} response was not valid JSON`);
      continue;
    }
  }

  // All providers failed
  return null;
}
