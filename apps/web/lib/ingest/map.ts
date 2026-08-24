/**
 * Fuzzy header auto-mapping: turns arbitrary spreadsheet headers into the
 * canonical fields RevenuePulse needs, then converts rows into Razorpay-shaped
 * raw events so they flow through the exact same pipeline as webhooks.
 */
import { categorizeFailure } from '@rp/razorpay';

export type CanonicalField =
  | 'provider_txn_id'
  | 'amount'
  | 'currency'
  | 'status'
  | 'method'
  | 'error_code'
  | 'error_description'
  | 'created_at'
  | 'email'
  | 'phone';

const SYNONYMS: Record<CanonicalField, string[]> = {
  provider_txn_id: ['payment_id', 'txn_id', 'transaction_id', 'txnid', 'id', 'ref', 'reference', 'receipt', 'order_id', 'utr'],
  amount: ['amount', 'value', 'amt', 'total', 'price', 'paid', 'payment_amount', 'transaction_amount', 'sum', 'gross'],
  currency: ['currency', 'curr', 'ccy', 'iso_currency'],
  status: ['status', 'state', 'result', 'outcome', 'payment_status', 'txn_status'],
  method: ['method', 'payment_method', 'mode', 'instrument', 'source', 'channel', 'payment_mode'],
  error_code: ['error_code', 'code', 'failure_code', 'reason_code', 'decline_code', 'error'],
  error_description: ['error_description', 'description', 'reason', 'message', 'error_message', 'failure_reason', 'remarks', 'notes', 'comment', 'detail'],
  created_at: ['created_at', 'date', 'timestamp', 'time', 'datetime', 'created', 'txn_date', 'payment_date', 'date_time'],
  email: ['email', 'customer_email', 'email_id', 'mail'],
  phone: ['phone', 'contact', 'mobile', 'customer_phone', 'number'],
};

export interface FieldMapping {
  field: CanonicalField;
  header: string;
  confidence: number; // 0..1
}

export interface MappingResult {
  mapping: Partial<Record<CanonicalField, string>>; // field -> original header
  details: FieldMapping[];
  unmappedHeaders: string[];
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
}

export function autoMapHeaders(headers: string[]): MappingResult {
  const mapping: Partial<Record<CanonicalField, string>> = {};
  const details: FieldMapping[] = [];
  const used = new Set<string>();

  // Exact/near-exact pass first
  for (const [field, synonyms] of Object.entries(SYNONYMS) as Array<[CanonicalField, string[]]>) {
    for (const h of headers) {
      if (used.has(h)) continue;
      const nh = normalizeHeader(h);
      if (nh === field || synonyms.includes(nh)) {
        mapping[field] = h;
        used.add(h);
        details.push({ field, header: h, confidence: 1 });
        break;
      }
    }
  }
  // Substring pass (e.g. "Payment Amount (INR)" -> amount)
  for (const [field, synonyms] of Object.entries(SYNONYMS) as Array<[CanonicalField, string[]]>) {
    if (mapping[field]) continue;
    let best: { h: string; score: number } | null = null;
    for (const h of headers) {
      if (used.has(h)) continue;
      const nh = normalizeHeader(h);
      let score = 0;
      if (nh.includes(field)) score = 0.9;
      else for (const s of synonyms) if (nh.includes(s)) { score = Math.max(score, 0.75); break; }
      if (!best || score > best.score) best = { h, score };
    }
    if (best && best.score >= 0.7) {
      mapping[field] = best.h;
      used.add(best.h);
      details.push({ field, header: best.h, confidence: best.score });
    }
  }

  return { mapping, details, unmappedHeaders: headers.filter((h) => !used.has(h)) };
}

/** Amount unit interpretation for ambiguous integer columns. */
export type AmountUnit = 'auto' | 'rupees' | 'paise';

const FAILED_TOKENS = /^(fail|failed|failure|declined|denied|reversed|refund|cancelled|canceled|expired|abandoned)/i;
const CAPTURED_TOKENS = /^(captured|success|succeeded|completed|paid|authorized|authorised)/i;

export interface RowConversion {
  rawEvent: Record<string, unknown> | null;
  reason?: string;
}

export function convertRow(
  row: Record<string, string>,
  mapping: Partial<Record<CanonicalField, string>>,
  opts: { amountUnit?: AmountUnit } = {},
  fallbackIndex = 0,
): RowConversion {
  const get = (f: CanonicalField): string => {
    const h = mapping[f];
    return h ? (row[h] ?? '').trim() : '';
  };

  const amountRaw = get('amount');
  if (!amountRaw) return { rawEvent: null, reason: 'missing amount' };

  const currencyHint = /₹|\brs\.?\b|\binr\b/i.test(amountRaw) ? 'INR' : '';
  const amountNum = parseFloat(amountRaw.replace(/[₹,\s]|rs\.?|inr/gi, ''));
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { rawEvent: null, reason: `invalid amount "${amountRaw}"` };
  }

  // Unit resolution: decimals or currency symbol => rupees. Integers =>
  // user override, else heuristic (values under 100k are almost always
  // rupees in real exports; paise values are typically 7+ digits).
  let paise: number;
  const hasDecimals = /\.\d{1,2}\s*$/.test(amountRaw.replace(/[^0-9.]/g, ''));
  if (opts.amountUnit === 'rupees') paise = Math.round(amountNum * 100);
  else if (opts.amountUnit === 'paise') paise = Math.round(amountNum);
  else if (hasDecimals || currencyHint === 'INR') paise = Math.round(amountNum * 100);
  else paise = amountNum < 100000 ? Math.round(amountNum * 100) : Math.round(amountNum);

  const statusRaw = get('status') || 'failed';
  let eventType = 'payment_failed';
  if (CAPTURED_TOKENS.test(statusRaw)) eventType = 'payment_captured';
  else if (!FAILED_TOKENS.test(statusRaw)) {
    // Unknown status: treat as failed only if explicitly requested context is absent
    eventType = 'payment_failed';
  }

  const errorCode = get('error_code');
  const errorDescription =
    get('error_description') ||
    (eventType === 'payment_captured' ? '' : 'imported failure (no description provided)');

  const createdAtRaw = get('created_at');
  const timeCreated = createdAtRaw && !Number.isNaN(new Date(createdAtRaw).getTime())
    ? new Date(createdAtRaw).toISOString()
    : new Date().toISOString();

  const id = get('provider_txn_id') || `import_${Date.now()}_${fallbackIndex}`;

  return {
    rawEvent: {
      event: eventType,
      data: {
        id,
        amount: paise,
        currency: (get('currency') || currencyHint || 'INR').toUpperCase(),
        status: eventType === 'payment_captured' ? 'captured' : 'failed',
        method: get('method').toLowerCase().replace(/\s+/g, '_') || 'unknown',
        error: { code: errorCode || undefined, description: errorDescription || undefined },
        time_created: timeCreated,
        email: get('email') || undefined,
        contact: get('phone') || undefined,
      },
    },
  };
}

/** Quick failure-category estimate for preview counts (no ML call). */
export function previewCategory(description: string, code: string): string {
  return categorizeFailure(code || undefined, description || undefined);
}
