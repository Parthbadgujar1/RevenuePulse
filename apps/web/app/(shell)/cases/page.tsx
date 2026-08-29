// Cases - every failed payment and its AI investigation
import Link from 'next/link';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../lib/merchant-context';
import { inr, categoryLabel, statusTone, timeAgo, SOURCE_LABELS } from '../../../lib/ui';
import { PageHeader, EmptyState } from '../../../components/ui/states';

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
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Recovery Cases"
        subtitle="Every failed payment gets an AI investigation: diagnosis → probability → policy-checked decision → bounded action → verified outcome."
      />

      {!ok && (
        <div className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning-ink">
          Database unreachable. Showing nothing until the store comes back.
        </div>
      )}

      {ok && cases.length === 0 && (
        <EmptyState
          title="No cases yet"
          message={
            <>
              Run a batch in the{' '}
              <Link href="/demo-lab" className="font-medium text-accent hover:underline">
                Demo Lab
              </Link>{' '}
              or send a webhook to <code className="font-mono text-[11px]">/api/webhooks/razorpay</code>.
            </>
          }
        />
      )}

      {ok && cases.length > 0 && (
        <div className="space-y-2">
          {cases.map((c) => {
            const diag = (c.diagnosis ?? {}) as Record<string, unknown>;
            const source = String(
              ((c as any).transaction?.paymentMethodDetails as any)?.source ?? 'webhook'
            );
            return (
              <Link
                key={c.id}
                href={`/cases/${c.id}`}
                className="block rounded-xl border border-edge bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-semibold text-accent">
                      {c.ref || c.id.slice(-6)}
                    </span>
                    <span className="font-semibold text-ink">{inr(c.amountAtRisk)}</span>
                    <span className={`rounded border px-2 py-0.5 text-xs font-medium ${statusTone(c.status)}`}>
                      {c.status.replace(/_/g, ' ')}
                    </span>
                    <span className="text-xs text-ink-3">{SOURCE_LABELS[source] ?? 'Webhook'}</span>
                  </div>
                  <div className="text-xs text-ink-2">
                    {timeAgo(c.createdAt)} · priority score {c.priority} · {c.attemptCount} attempt
                    {c.attemptCount === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="mt-1 text-sm capitalize text-ink-2">
                  {categoryLabel(String(diag.primaryCategory || 'unknown'))}
                  {diag.failureCode ? (
                    <span className="ml-2 font-mono text-xs text-ink-3">{String(diag.failureCode)}</span>
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
