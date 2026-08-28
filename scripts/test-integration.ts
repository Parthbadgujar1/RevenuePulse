/**
 * Integration tests — require a running PostgreSQL (DATABASE_URL).
 *
 * Covers contracts that only hold against a real database:
 *   1. Webhook idempotency (duplicate providerEventId is a no-op)
 *   2. Cross-tenant isolation (merchant-scoped reads never leak)
 *   3. RBAC 403 (route permission gate maps to ForbiddenError/403)
 *   4. Duplicate execution guard (second run is already_executed)
 *   5. Max retries (retry window exhaustion + per-case RetrySchedule)
 *
 * Run in CI only (a Postgres service is provisioned there):
 *   npm run test:integration
 */
import {
  prisma,
  ensureDemoMerchant,
  registerWebhookEvent,
} from '../packages/database';
import { processJob, JobType } from '@rp/observability';
import { hasPermission } from '@rp/auth';
import { requirePermission, apiErrorStatus } from '../apps/web/lib/merchant-context';
import { RETRY_WINDOWS, shouldRetry } from '../packages/domain/src/services/retry-sequencer';

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

const now = Date.now();
const uid = (prefix: string) => `${prefix}_${now}_${Math.random().toString(36).slice(2, 8)}`;

async function ensureMerchant(id: string, name: string): Promise<string> {
  await prisma.merchant.upsert({
    where: { id },
    update: {},
    create: { id, name, currency: 'INR', createdAt: new Date() },
  });
  return id;
}

async function createCase(merchantId: string, tag: string) {
  const tx = await prisma.transaction.create({
    data: {
      providerTransactionId: uid(`itx_${tag}`),
      merchantId,
      amount: 250000,
      currency: 'INR',
      status: 'failed',
      paymentMethod: 'card',
      occurredAt: new Date(),
      createdAt: new Date(),
    },
  });
  const kase = await prisma.revenueCase.create({
    data: {
      transactionId: tx.id,
      caseType: 'payment_degradation',
      amountAtRisk: 250000,
      priority: 70,
      status: 'DETECTED',
      merchantId,
      attemptCount: 0,
      diagnosis: { primaryCategory: 'network_timeout' } as any,
      createdAt: new Date(),
    },
  });
  return { txId: tx.id, caseId: kase.id };
}

async function cleanup() {
  const merchantIds = ['it-merchant-a', 'it-merchant-b'];
  try {
    await prisma.auditLog.deleteMany({ where: { merchantId: { in: merchantIds } } });
    await prisma.retrySchedule.deleteMany({ where: { merchantId: { in: merchantIds } } });
    const cases = await prisma.revenueCase.findMany({
      where: { merchantId: { in: merchantIds } },
      select: { id: true, transactionId: true },
    });
    const caseIds = cases.map((c) => c.id);
    const txIds = cases.map((c) => c.transactionId);
    if (caseIds.length) {
      const actions = await prisma.recoveryAction.findMany({ where: { caseId: { in: caseIds } } });
      const actionIds = actions.map((a) => a.id);
      if (actionIds.length) await prisma.outcome.deleteMany({ where: { actionId: { in: actionIds } } });
      await prisma.recoveryAction.deleteMany({ where: { caseId: { in: caseIds } } });
    }
    await prisma.revenueCase.deleteMany({ where: { merchantId: { in: merchantIds } } });
    if (txIds.length) await prisma.transaction.deleteMany({ where: { id: { in: txIds } } });
    await prisma.webhookEvent.deleteMany({ where: { merchantId: { in: merchantIds } } });
    await prisma.providerConnection.deleteMany({ where: { merchantId: { in: merchantIds } } });
    await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } });
  } catch {
    // best-effort cleanup; CI DB is disposable
  }
}

async function main() {
  // Connectivity gate: fail loudly with an actionable message if no DB.
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.error(
      'FATAL: Integration tests require a running PostgreSQL.\n' +
        'Set DATABASE_URL and apply migrations (npx prisma migrate deploy) first.',
      (err as Error).message
    );
    process.exit(2);
  }

  await ensureDemoMerchant(prisma, 'demo-merchant');
  const merchantA = await ensureMerchant('it-merchant-a', 'Integration Tenant A');
  const merchantB = await ensureMerchant('it-merchant-b', 'Integration Tenant B');

  // ── 1. Webhook idempotency ───────────────────────────────────────────────
  {
    const rawBody = JSON.stringify({
      event: 'payment.failed',
      data: { payment: { entity: { id: 'pay_it_dup_1', amount: 250000, status: 'failed' } } },
    });
    const first = await registerWebhookEvent(prisma, {
      providerEventId: 'evt_it_dup_1',
      eventType: 'payment.failed',
      rawBody,
      merchantId: merchantA,
    });
    assert(first.duplicate === false, 'webhook first registration is accepted');
    const dup = await registerWebhookEvent(prisma, {
      providerEventId: 'evt_it_dup_1',
      eventType: 'payment.failed',
      rawBody,
      merchantId: merchantA,
    });
    assert(dup.duplicate === true, 'duplicate providerEventId is a no-op');
    const count = await prisma.webhookEvent.count({
      where: { providerEventId: 'evt_it_dup_1' },
    });
    assert(count === 1, 'exactly one WebhookEvent row persists', { count });
  }

  // ── 2. Cross-tenant isolation ─────────────────────────────────────────────
  {
    const a = await createCase(merchantA, 'a');
    const b = await createCase(merchantB, 'b');

    const aSeenByB = await prisma.revenueCase.findFirst({
      where: { id: a.caseId, merchantId: merchantB },
    });
    assert(aSeenByB === null, 'tenant B cannot read tenant A case');
    const bSeenByB = await prisma.revenueCase.findFirst({
      where: { id: b.caseId, merchantId: merchantB },
    });
    assert(bSeenByB !== null, 'tenant B reads its own case');
  }

  // ── 3. RBAC 403 ──────────────────────────────────────────────────────────
  {
    assert(
      hasPermission('MERCHANT_OWNER', 'actions:approve') === true,
      'MERCHANT_OWNER may approve actions'
    );
    assert(
      hasPermission('SUPPORT_OPERATOR', 'actions:approve') === false,
      'SUPPORT_OPERATOR cannot approve actions'
    );
    let threw = false;
    try {
      requirePermission({ role: 'SUPPORT_OPERATOR' }, 'actions:approve');
    } catch (err) {
      threw = true;
      assert(apiErrorStatus(err) === 403, 'RBAC violation maps to 403 Forbidden');
    }
    assert(threw, 'requirePermission throws for missing permission');
  }

  // ── 4. Duplicate execution guard ─────────────────────────────────────────
  {
    const { caseId } = await createCase(merchantA, 'guard');
    await prisma.recoveryAction.create({
      data: {
        caseId,
        actionType: 'retry_later',
        policySnapshot: {},
        expectedCost: 1200,
        expectedNetRecovery: 248800,
        approvalStatus: 'approved',
        executionStatus: 'EXECUTED',
        idempotencyKey: uid('idem_exec'),
        createdAt: new Date(),
      },
    });
    const action = await prisma.recoveryAction.findFirst({
      where: { caseId },
      orderBy: { createdAt: 'desc' },
    });
    const firstRun = await processJob({} as any, JobType.EXECUTE_ACTION, {
      actionId: action!.id,
      simulated: false,
    });
    assert(firstRun.success === true && firstRun.result === 'already_executed',
      're-executing an EXECUTED action is refused', firstRun);
    const outcomes = await prisma.outcome.count({ where: { actionId: action!.id } });
    assert(outcomes === 0, 'no outcome fabricated by a refused duplicate run');
  }

  // ── 5. Max retries + per-case RetrySchedule ──────────────────────────────
  {
    const window = RETRY_WINDOWS.network_timeout;
    assert(window !== null && window.maxRetries === 5, 'network_timeout allows 5 retries');
    const exhausted = shouldRetry(window, 5, 80);
    assert(exhausted.retry === false && exhausted.reason.includes('exhausted'),
      '5th retry is exhausted', exhausted);
    const permitted = shouldRetry(window, 3, 80);
    assert(permitted.retry === true, 'retry 4 of 5 still permitted', permitted);
    assert(
      RETRY_WINDOWS.expired_instrument === null,
      'expired_instrument has no retry window'
    );

    // RetrySchedule is unique per case — scheduling twice is refused (P2002).
    const { caseId } = await createCase(merchantA, 'retry');
    await prisma.retrySchedule.create({
      data: {
        caseId,
        merchantId: merchantA,
        failureCategory: 'network_timeout',
        retryWindow: window as any,
        currentRetry: 1,
        maxRetries: window.maxRetries,
        nextRetryAt: new Date(Date.now() + 86_400_000),
        status: 'scheduled',
        createdAt: new Date(),
      },
    });
    let doubleScheduleBlocked = false;
    try {
      await prisma.retrySchedule.create({
        data: {
          caseId,
          merchantId: merchantA,
          failureCategory: 'network_timeout',
          retryWindow: window as any,
          currentRetry: 2,
          maxRetries: window.maxRetries,
          nextRetryAt: new Date(Date.now() + 172_800_000),
          status: 'scheduled',
          createdAt: new Date(),
        },
      });
    } catch (err) {
      doubleScheduleBlocked =
        typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
    }
    assert(doubleScheduleBlocked, 'RetrySchedule unique-per-case blocks duplicate scheduling');
  }

  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error('Integration tests threw:', err);
  process.exit(1);
});