// Cases - every failed payment and its AI investigation
import Link from 'next/link';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../lib/merchant-context';
import { inr, categoryLabel, statusTone, timeAgo, SOURCE_LABELS } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function CasesPage() {
  let cases: Awaited<ReturnType<typeof prisma.revenueCase.findMany>> = [];
  let ok = true;
  try {
    const { merchantId } = await requireMerchantContext();
    cases = await prisma.revenueCase.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { transaction: { select: { paymentMethodDetails: true } } },
    });
  } catch {
    ok = false;
  }

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Recovery Cases</h1>
      <p className="mt-1 text-sm text-gray-500">
        Every failed payment gets an AI investigation: diagnosis → probability → policy-checked
        decision → bounded action → verified outcome.
      </p>

      {!ok && (
        <div className="mt-4 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-800">
          Database unreachable.
        </div>
      )}

      {ok && cases.length === 0 && (
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
          No cases yet. Run a batch in the{' '}
          <Link href="/demo-lab" className="font-medium text-emerald-600 hover:underline">
            Demo Lab
          </Link>{' '}
          or send a webhook to <code>/api/webhooks/razorpay</code>.
        </div>
      )}

      <div className="mt-6 space-y-2">
        {cases.map((c) => {
          const diag = (c.diagnosis ?? {}) as Record<string, unknown>;
          const source = String(
            ((c as any).transaction?.paymentMethodDetails as any)?.source ?? 'webhook'
          );
          return (
            <Link
              key={c.id}
              href={`/cases/${c.id}`}
              className="block rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition hover:border-emerald-400 hover:shadow"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-semibold text-emerald-700">
                    {c.ref || c.id.slice(-6)}
                  </span>
                  <span className="font-semibold text-gray-900">{inr(c.amountAtRisk)}</span>
                  <span className={`rounded border px-2 py-0.5 text-xs font-medium ${statusTone(c.status)}`}>
                    {c.status.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-gray-400">
                    {SOURCE_LABELS[source] ?? '🔵 Webhook'}
                  </span>
                </div>
                <div className="text-xs text-gray-500">
                  {timeAgo(c.createdAt)} · priority score {c.priority} · {c.attemptCount} attempt
                  {c.attemptCount === 1 ? '' : 's'}
                </div>
              </div>
              <div className="mt-1 text-sm capitalize text-gray-600">
                {categoryLabel(String(diag.primaryCategory || 'unknown'))}
                {diag.failureCode ? (
                  <span className="ml-2 font-mono text-xs text-gray-400">
                    {String(diag.failureCode)}
                  </span>
                ) : null}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
