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
import { classifyProviderPaymentStatus } from '../apps/web/lib/provider-status';
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

// ---------------------------------------------------------------------------
// 7. Live-outcome classification (Razorpay payment status -> outcome bucket)
//    captured = recovered; failed/cancelled = not recovered; everything else
//    (authorized, refunded, created, unknown) must stay pending — never
//    fabricate an outcome from a non-terminal status.
// ---------------------------------------------------------------------------
assert(classifyProviderPaymentStatus('captured') === 'recovered', 'captured -> recovered');
assert(classifyProviderPaymentStatus('CAPTURED') === 'recovered', 'case-insensitive captured');
assert(classifyProviderPaymentStatus('failed') === 'not_recovered', 'failed -> not_recovered');
assert(classifyProviderPaymentStatus('cancelled') === 'not_recovered', 'cancelled -> not_recovered');
for (const pending of ['authorized', 'refunded', 'created', 'processed', '', undefined, null]) {
  assert(
    classifyProviderPaymentStatus(pending) === 'pending',
    `non-terminal "${String(pending)}" stays pending`,
    classifyProviderPaymentStatus(pending)
  );
}

// ---------------------------------------------------------------------------
// 8. Shared intervention-lift table (single source of truth)
//    The decision engine and the ground-truth simulator must agree: the
//    simulator consumes getInterventionLift directly, so a regression here
//    means someone re-introduced a divergent hardcoded table.
// ---------------------------------------------------------------------------
import {
  getInterventionLift,
  INTERVENTION_LIFTS,
} from '../packages/policies/src/intervention-lifts';
import { simulateGroundTruthOutcome } from '../packages/observability/src/queue';
import { FailureCategory } from '../packages/domain/src/constants/failure-taxonomy';

assert(
  getInterventionLift('payment_method_recovery', 'expired_instrument') === 0.24,
  'card-update lift on expired instrument is +0.24'
);
assert(
  getInterventionLift('retry_later', 'expired_instrument') === -0.18,
  'blind retry on expired instrument is -0.18'
);
assert(
  getInterventionLift('human_escalation', 'customer_cancellation') === -0.02,
  'escalation on voluntary cancel is -0.02 (modest last resort)'
);
assert(getInterventionLift('unknown_action', 'insufficient_funds') === 0, 'unknown action is neutral');
assert(getInterventionLift('timed_reminder', 'some_new_category') === 0.01, 'unknown category falls back to default');

// Simulator parity: with attemptCount=0 (no retry-fatigue term), simulator
// output must equal categoryBase + shared lift for every action/category pair.
// This pins the simulator to the shared table so engine expectations and
// simulated reality can never silently diverge.
import { GROUND_TRUTH_BASE_RATES } from '../packages/observability/src/queue';
for (const action of Object.keys(INTERVENTION_LIFTS)) {
  for (const cat of Object.values(FailureCategory)) {
    const categoryBase = GROUND_TRUTH_BASE_RATES[cat] ?? 0.4;
    const expected = Math.min(0.95, Math.max(0.02, categoryBase + getInterventionLift(action, cat)));
    const actual = simulateGroundTruthOutcome(cat, action, 0);
    assert(
      Math.abs(actual - expected) < 1e-9,
      `simulator parity ${action}/${cat}`,
      { expected, actual }
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
