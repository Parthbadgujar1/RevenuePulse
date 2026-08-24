/**
 * Pure unit tests — no database required.
 * Covers: Razorpay payload normalization (real nested + legacy flat shapes)
 * and the ML feature mapping contract (camelCase -> snake_case).
 *
 * Run: npm test  (wired to tsx scripts/test-unit.ts)
 */
import {
  normalizeRazorpayEvent,
  categorizeFailure,
} from '../packages/razorpay/src/index';
import { toMlFeatures } from '../packages/observability/src/ml-client';
import type { RecoveryFeatures } from '../packages/domain/src';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, extra?: unknown) {
  if (cond) {
    passed++;
    console.log(`PASS - ${name}`);
  } else {
    failed++;
    console.error(`FAIL - ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

// ---------------------------------------------------------------------------
// 1. REAL Razorpay webhook shape: data.payment.entity (nested)
// ---------------------------------------------------------------------------
const realPaymentFailed = {
  event: 'payment.failed',
  data: {
    payment: {
      entity: {
        id: 'pay_NxZq1a2B3c4D5e',
        amount: 250000,
        currency: 'INR',
        status: 'failed',
        method: 'card',
        error_code: 'GATEWAY_ERROR',
        error_description: 'Issuer bank declined the transaction',
        created_at: 1756000000, // unix seconds
        email: 'cust@example.com',
        contact: '+919876543210',
      },
    },
  },
};
const n1 = normalizeRazorpayEvent(realPaymentFailed as any);
assert(n1.eventType === 'payment_failed', 'nested payment.failed -> event type', n1.eventType);
assert(n1.safeMetadata.providerTransactionId === 'pay_NxZq1a2B3c4D5e', 'nested -> provider id', n1.safeMetadata.providerTransactionId);
assert(n1.safeMetadata.amount === 250000, 'nested -> amount');
assert(n1.safeMetadata.paymentMethod === 'card', 'nested -> method');
assert(n1.safeMetadata.failureCategory === 'bank_failure', 'GATEWAY_ERROR categorized as bank_failure', n1.safeMetadata.failureCategory);
assert(
  typeof n1.safeMetadata.occurredAt === 'number' && n1.safeMetadata.occurredAt === 1756000000000,
  'unix seconds converted to ms',
  n1.safeMetadata.occurredAt
);
assert(!(n1.safeMetadata as any).card && !(n1.safeMetadata as any).token, 'no card/token leakage');

// ---------------------------------------------------------------------------
// 2. Nested payment.captured
// ---------------------------------------------------------------------------
const realCaptured = {
  event: 'payment.captured',
  data: { payment: { entity: { id: 'pay_Cap1', amount: 99900, currency: 'INR', status: 'captured', method: 'upi', created_at: 1756000100 } } },
};
const n2 = normalizeRazorpayEvent(realCaptured as any);
assert(n2.eventType === 'payment_captured', 'nested payment.captured -> event type', n2.eventType);

// ---------------------------------------------------------------------------
// 3. subscription.charged nested entity
// ---------------------------------------------------------------------------
const realSub = {
  event: 'subscription.charged',
  data: { subscription: { entity: { id: 'sub_Abc123', amount_paid: 150000, currency: 'INR', status: 'active', created_at: 1756000200 } } },
};
const n3 = normalizeRazorpayEvent(realSub as any);
assert(n3.eventType === 'payment_captured', 'subscription.charged maps to money-in captured', n3.eventType);
assert(n3.safeMetadata.providerTransactionId === 'sub_Abc123', 'subscription entity id extracted', n3.safeMetadata.providerTransactionId);
assert(n3.safeMetadata.amount === 150000, 'subscription amount_paid read');

// ---------------------------------------------------------------------------
// 4. Legacy flat simulation shape still works
// ---------------------------------------------------------------------------
const flatSim = {
  event_type: 'payment_failed',
  data: {
    id: 'sim_001',
    amount: 50000,
    currency: 'INR',
    status: 'failed',
    method: 'netbanking',
    error: { code: 'INSUFFICIENT_FUNDS', description: 'Insufficient funds in account' },
    time_created: '2026-08-24T10:00:00Z',
  },
};
const n4 = normalizeRazorpayEvent(flatSim as any);
assert(n4.eventType === 'payment_failed', 'flat sim -> event type');
assert(n4.safeMetadata.providerTransactionId === 'sim_001', 'flat sim -> id');
assert(n4.safeMetadata.amount === 50000, 'flat sim -> amount');
assert(n4.safeMetadata.failureCategory === 'insufficient_funds', 'flat sim -> category', n4.safeMetadata.failureCategory);

// ---------------------------------------------------------------------------
// 5. categorizeFailure sanity
// ---------------------------------------------------------------------------
assert(categorizeFailure('CARD_EXPIRED', '') === 'expired_instrument', 'expired card category');

// ---------------------------------------------------------------------------
// 6. ML feature mapping contract
// ---------------------------------------------------------------------------
const features: RecoveryFeatures = {
  amount: 100000,
  failureCategory: 'insufficient_funds' as RecoveryFeatures['failureCategory'],
  paymentMethod: 'card',
  historicalSuccessRate: 0.6,
  numberOfPreviousFailures: 1,
  timeSinceFailureHours: 3,
  transactionHour: 14,
  retryCount: 0,
  isSubscription: false,
  merchantHistoricalRate: 0.55,
  failureCategoryHistoricalRate: 0.4,
  amountPercentile: 0.7,
} as any;
const ml = toMlFeatures(features);
assert((ml as any).failure_category === 'insufficient_funds', 'mapping failure_category');
assert((ml as any).number_of_previous_failures === 1, 'mapping number_of_previous_failures');
assert((ml as any).amount_percentile === 0.7, 'mapping amount_percentile');
assert(Object.keys(ml as any).length === 12, 'exactly 12 ML features', Object.keys(ml as any));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
