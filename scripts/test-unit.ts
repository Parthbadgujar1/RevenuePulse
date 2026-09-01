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
assert((ml as any).intervention === 'none', 'default intervention maps to none');
assert((ml as any).day_of_week === 2, 'default day_of_week maps to Wed');
assert((ml as any).contact_channel === 'none', 'default contact_channel maps to none');
assert((ml as any).merchant_vertical === 'other', 'default merchant_vertical maps to other');
assert(Object.keys(ml as any).length === 18, 'exactly 18 ML features', Object.keys(ml as any));

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

// ---------------------------------------------------------------------------
// 7. Checkout Recovery — probability calculation + incentive selection
// ---------------------------------------------------------------------------
import {
  calculateCheckoutRecoveryProbability,
  selectIncentive,
  CHECKOUT_ABANDONMENT_RATES,
} from '../packages/domain/src/services/checkout-recovery';

const checkoutFeatures = {
  sessionId: 'cs_test_001',
  amount: 50000,
  customerEmail: 'test@example.com',
  abandonmentReason: 'payment_failed' as const,
  timeSinceAbandonmentHours: 2,
  cartValue: 50000,
  itemCount: 3,
  previousPurchases: 5,
  customerSegment: 'returning' as const,
};

const checkoutPrediction = calculateCheckoutRecoveryProbability(checkoutFeatures);
assert(checkoutPrediction.probability >= 0 && checkoutPrediction.probability <= 1,
  'checkout recovery probability in [0,1]');
assert(checkoutPrediction.recommendedIncentive.type !== undefined,
  'checkout recovery has recommended incentive');

const incentive = selectIncentive(checkoutFeatures, checkoutPrediction.probability);
assert(incentive.type !== undefined, 'selectIncentive returns a type');
assert(typeof incentive.value === 'number', 'selectIncentive returns numeric value');
assert(typeof incentive.reasoning === 'string', 'selectIncentive returns reasoning');

assert(CHECKOUT_ABANDONMENT_RATES['payment_failed'] > 0,
  'CHECKOUT_ABANDONMENT_RATES has payment_failed');
assert(CHECKOUT_ABANDONMENT_RATES['network_error'] > CHECKOUT_ABANDONMENT_RATES['user_exit'],
  'network_error has higher recovery rate than user_exit');

// VIP customers should have higher probability than new customers
const vipFeatures = { ...checkoutFeatures, customerSegment: 'vip' as const, previousPurchases: 25 };
const vipPrediction = calculateCheckoutRecoveryProbability(vipFeatures);
const newFeatures = { ...checkoutFeatures, customerSegment: 'new' as const, previousPurchases: 0 };
const newPrediction = calculateCheckoutRecoveryProbability(newFeatures);
assert(vipPrediction.probability >= newPrediction.probability,
  'VIP customer has higher recovery probability than new customer',
  { vip: vipPrediction.probability, new: newPrediction.probability });

// ---------------------------------------------------------------------------
// 8. Receivables Chaser — aging buckets + collection priority + payment plans
// ---------------------------------------------------------------------------
import {
  calculateAgingBucket,
  calculateCollectionPriority,
  generatePaymentPlan,
  BASE_COLLECTION_RATES,
} from '../packages/domain/src/services/receivables-chaser';

assert(calculateAgingBucket(5) === '0-30', '5 days overdue -> 0-30 bucket');
assert(calculateAgingBucket(30) === '0-30', '30 days overdue -> 0-30 bucket');
assert(calculateAgingBucket(31) === '31-60', '31 days overdue -> 31-60 bucket');
assert(calculateAgingBucket(60) === '31-60', '60 days overdue -> 31-60 bucket');
assert(calculateAgingBucket(61) === '61-90', '61 days overdue -> 61-90 bucket');
assert(calculateAgingBucket(90) === '61-90', '90 days overdue -> 61-90 bucket');
assert(calculateAgingBucket(91) === '90+', '91 days overdue -> 90+ bucket');
assert(calculateAgingBucket(365) === '90+', '365 days overdue -> 90+ bucket');

const highPriority = calculateCollectionPriority({
  amount: 500000, overdueDays: 75, previousOnTimePayments: 0,
  previousLatePayments: 5, customerHealthScore: 20, dueDate: '2026-06-01',
});
const lowPriority = calculateCollectionPriority({
  amount: 10000, overdueDays: 5, previousOnTimePayments: 20,
  previousLatePayments: 0, customerHealthScore: 90, dueDate: '2026-08-20',
});
assert(highPriority.score > lowPriority.score,
  'high overdue + low health has higher priority than low overdue + high health',
  { high: highPriority.score, low: lowPriority.score });
assert(highPriority.tier === 'critical' || highPriority.tier === 'high',
  'high overdue invoice gets critical/high tier');
assert(lowPriority.tier === 'low' || lowPriority.tier === 'medium',
  'low overdue invoice gets low/medium tier');

const plan = generatePaymentPlan({ amount: 1200000, dueDate: '2026-09-01', overdueDays: 45, previousOnTimePayments: 5, previousLatePayments: 1, customerHealthScore: 70 }, 4);
assert(plan.length >= 2 && plan.length <= 4, 'payment plan generates 2-4 installments');
assert(plan[0].amount > 0, 'first installment has positive amount');
const totalFromPlan = plan.reduce((s, i) => s + i.amount, 0);
assert(Math.abs(totalFromPlan - 1200000) < 10, 'installments sum to invoice amount',
  { sum: totalFromPlan, expected: 1200000 });

assert(BASE_COLLECTION_RATES['0-30'] > BASE_COLLECTION_RATES['90+'],
  '0-30 bucket has higher collection rate than 90+');

// ---------------------------------------------------------------------------
// 9. Retry Sequencer — next retry time + shouldRetry
// ---------------------------------------------------------------------------
import {
  RETRY_WINDOWS,
  calculateNextRetryTime,
  shouldRetry,
} from '../packages/domain/src/services/retry-sequencer';

assert(RETRY_WINDOWS['network_timeout'] !== null, 'network_timeout has retry config');
assert(RETRY_WINDOWS['network_timeout']!.maxRetries === 5, 'network_timeout allows 5 retries');
assert(RETRY_WINDOWS['insufficient_funds'] !== null, 'insufficient_funds has retry config');
assert(RETRY_WINDOWS['expired_instrument'] === null, 'expired_instrument has NO retry (needs card update)');
assert(RETRY_WINDOWS['customer_cancellation'] === null, 'customer_cancellation has NO retry');

const nwWindow = RETRY_WINDOWS['network_timeout']!;
const nextRetry = calculateNextRetryTime(nwWindow, 1);
const nextRetryDate = new Date(nextRetry.retryAt);
assert(nextRetryDate > new Date(), 'next retry time is in the future');
assert(nextRetry.attempt === 2, 'second retry attempt');
assert(nextRetry.delayHours > nwWindow.baseHours, 'exponential backoff increases delay');

// Exponential: attempt 2 should be > 2x baseHours
const thirdRetry = calculateNextRetryTime(nwWindow, 2);
assert(thirdRetry.delayHours > nextRetry.delayHours,
  'exponential backoff increases with attempt');

// Should retry: first attempt within limit should retry
const retry1 = shouldRetry(nwWindow, 1, 80);
assert(retry1.retry === true, 'retry 1 of 5 with health 80 -> should retry');
const retry5 = shouldRetry(nwWindow, 5, 80);
assert(retry5.retry === false, 'retry 5 of 5 with health 80 -> exhausted');
const retryLow = shouldRetry(nwWindow, 1, 10);
assert(retryLow.retry === false, 'retry 1 with health 10 -> customer too unhealthy');

// No-window categories should never retry
const nullWindow = RETRY_WINDOWS['expired_instrument'];
assert(nullWindow === null, 'expired_instrument has null window');
if (nullWindow !== null) {
  const nullRetry = shouldRetry(nullWindow, 0, 80);
  assert(nullRetry.retry === false, 'null window -> no retry');
}

// ---------------------------------------------------------------------------
// 10. Promise Tracker — violation checking + escalation
// ---------------------------------------------------------------------------
import {
  checkPromiseViolation,
  getEscalationAction,
  calculatePromiseKeepingRate,
  EscalationLevel,
  PROMISE_KEEPING_RATES,
} from '../packages/domain/src/services/promise-tracker';

const pendingPromise = {
  id: 'pt_001', merchantId: 'm_001', customerId: 'c_001',
  amount: 25000, promisedDate: '2026-08-20T00:00:00Z',
  channel: 'phone' as const, status: 'pending' as const,
  escalationLevel: EscalationLevel.INITIAL, createdAt: '2026-08-15T00:00:00Z',
};

// Promise not yet due
const futurePromise = { ...pendingPromise, promisedDate: '2026-12-01T00:00:00Z' };
const futureResult = checkPromiseViolation(futurePromise, new Date('2026-08-26T00:00:00Z'));
assert(futureResult.violated === false, 'future promise is not violated');

// Promise overdue
const pastPromise = { ...pendingPromise, promisedDate: '2026-08-20T00:00:00Z' };
const pastResult = checkPromiseViolation(pastPromise, new Date('2026-08-26T00:00:00Z'));
assert(pastResult.violated === true, 'past promise is violated');
assert(pastResult.daysOverdue >= 5, 'past promise has days overdue >= 5',
  { daysOverdue: pastResult.daysOverdue });
assert(typeof pastResult.nextAction === 'string' && pastResult.nextAction.length > 0,
  'violation result has nextAction');

// Escalation actions exist for all levels
const action0 = getEscalationAction(EscalationLevel.INITIAL);
const action1 = getEscalationAction(EscalationLevel.FIRST_REMINDER);
const action2 = getEscalationAction(EscalationLevel.FINAL);
const action3 = getEscalationAction(EscalationLevel.ESCALATED);
assert(typeof action0.action === 'string' && action0.action.length > 0, 'INITIAL has action');
assert(typeof action3.action === 'string' && action3.action.length > 0, 'ESCALATED has action');
assert(action3.triggerDays >= action0.triggerDays, 'escalation trigger days increases');

// Promise keeping rate calculation
const testPromises = [
  { ...pendingPromise, status: 'kept' as const },
  { ...pendingPromise, id: 'pt_002', status: 'kept' as const },
  { ...pendingPromise, id: 'pt_003', status: 'violated' as const },
];
const stats = calculatePromiseKeepingRate('m_001', testPromises);
assert(stats.keepingRate > 0 && stats.keepingRate <= 1, 'keeping rate is in (0, 1]');
assert(stats.totalPromises === 3, 'total promises counted correctly');
assert(stats.keptPromises === 2, 'kept promises counted correctly');

assert(PROMISE_KEEPING_RATES['phone'] > PROMISE_KEEPING_RATES['sms'],
  'phone has higher keeping rate than sms');
assert(PROMISE_KEEPING_RATES['whatsapp'] > PROMISE_KEEPING_RATES['email'],
  'whatsapp has higher keeping rate than email');

// ---------------------------------------------------------------------------
// 11. ADVERSARIAL — policy guardrails (isInterventionAllowed) + economics
//     net consistency. These pin the money-action gateway to fail CLOSED on
//     broken inputs and to enforce every merchant guardrail with the REAL
//     probability/context, never a hardcoded default.
// ---------------------------------------------------------------------------
import {
  isInterventionAllowed,
  calculateEconomics,
  InterventionType,
} from '../packages/domain/src';
import { DEFAULT_MERCHANT_POLICY } from '../packages/policies/src/decision-engine';

const pol = DEFAULT_MERCHANT_POLICY as any;
const advFeatures: RecoveryFeatures = {
  amount: 100000,
  failureCategory: 'insufficient_funds' as RecoveryFeatures['failureCategory'],
  paymentMethod: 'card',
  historicalSuccessRate: 0.6,
  numberOfPreviousFailures: 0,
  timeSinceFailureHours: 3,
  transactionHour: 12,
  retryCount: 0,
  isSubscription: false,
  merchantHistoricalRate: 0.5,
  failureCategoryHistoricalRate: 0.4,
  amountPercentile: 0.5,
} as any;

const allowRetry = (opts?: any) =>
  isInterventionAllowed(InterventionType.RETRY_LATER, pol, advFeatures, opts);

// Fail-closed: NO probability supplied must never be treated as allowed.
{
  const r = allowRetry(undefined);
  assert(r.allowed === false, 'missing probability fails closed (do nothing)');
}
{
  const r = allowRetry({ probability: Number.NaN });
  assert(r.allowed === false, 'NaN probability fails closed');
}

// Customer decline hard stop.
{
  const r = allowRetry({ probability: 0.9, customerDeclined: true });
  assert(r.allowed === false && /declined/i.test(r.reason),
    'stopOnCustomerDecline blocks when customer declined', r);
}
// Repeated failures hard stop.
{
  const r = allowRetry({ probability: 0.9, repeatedFailures: true });
  assert(r.allowed === false, 'stopOnRepeatedFailure blocks repeated failures', r);
}
// Max retry count gate (default maximumRetryCount=3): attemptCount 3 is blocked.
{
  const ok = allowRetry({ probability: 0.9, attemptCount: 2 });
  assert(ok.allowed === true, 'retry allowed at attemptCount 2 (< max 3)');
  const blocked = allowRetry({ probability: 0.9, attemptCount: 3 });
  assert(blocked.allowed === false && /retry count/i.test(blocked.reason),
    'retry blocked at attemptCount 3 (>= max 3)', blocked);
}
// Max contact count gate (default maximumContactCount=2).
{
  const blocked = allowRetry({ probability: 0.9, contactCount: 2 });
  assert(blocked.allowed === false, 'contact count 2 (>= max 2) blocked', blocked);
}
// Case lifetime gate (default maximumCaseLifetime=30 days -> 720h).
{
  const ok = allowRetry({ probability: 0.9, caseAgeHours: 719 });
  assert(ok.allowed === true, 'case at 719h (< 30d) allowed');
  const blocked = allowRetry({ probability: 0.9, caseAgeHours: 721 });
  assert(blocked.allowed === false, 'case at 721h (> 30d) blocked', blocked);
}
// Cooldown gate (default cooldownPeriod=24h).
{
  const blocked = allowRetry({
    probability: 0.9,
    lastAttemptAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
  });
  assert(blocked.allowed === false, 'retry within 24h cooldown blocked', blocked);
  const ok = allowRetry({
    probability: 0.9,
    lastAttemptAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
  });
  assert(ok.allowed === true, 'retry after >24h cooldown allowed');
}
// Minimum recovery probability (default minimumRecoveryProbability=0.2):
// retry_later prerequisite also requires probability >= 0.3.
{
  const blocked = allowRetry({ probability: 0.25 });
  assert(blocked.allowed === false, 'probability below retry prerequisite (0.3) blocked', blocked);
  const ok = allowRetry({ probability: 0.5 });
  assert(ok.allowed === true, 'probability 0.5 allowed');
}
// Maximum recovery value gate (default maximumRecoveryValue=2500000).
{
  const bigFeatures = { ...advFeatures, amount: 3_000_000 };
  const r = isInterventionAllowed(InterventionType.RETRY_LATER, pol, bigFeatures as any, {
    probability: 0.8,
  });
  assert(r.allowed === false && /exceeds merchant maximum/i.test(r.reason),
    'amount above maximumRecoveryValue blocked', r);
}

// ── Economics net formula: net = expectedRecoveryValue - actionCost - incentiveCost
{
  const e = calculateEconomics(100000, 0.5, 2000, 8000);
  assert(e.expectedRecoveryValue === 50000, 'expectedRecoveryValue = amount * probability');
  assert(e.expectedNetRecovery === 50000 - 2000 - 8000,
    'net = gross - actionCost - incentiveCost',
    { gross: e.expectedRecoveryValue, cost: 2000, incentive: 8000, net: e.expectedNetRecovery });
  assert(e.expectedNetRecovery === 40000,
    'net arithmetic exact', e.expectedNetRecovery);
  assert(e.policyEligible === true, 'positive-net case is policy eligible');

  const negative = calculateEconomics(10000, 0.1, 2000, 3000);
  assert(negative.expectedNetRecovery === 10000 * 0.1 - 2000 - 3000,
    'negative net computed correctly', negative.expectedNetRecovery);
  assert(negative.policyEligible === false, 'negative-net case ineligible');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);