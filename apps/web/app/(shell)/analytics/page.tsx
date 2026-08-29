import RecoveryAnalytics from '../../../components/recovery-analytics';

export const dynamic = 'force-dynamic';

export default function AnalyticsPage() {
  return (
    <div className="mx-auto max-w-6xl">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-100">
          Recovery Analytics
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Recovery rates by payment method, gateway, failure reason, and region.
        </p>
        <div className="mt-6">
          <RecoveryAnalytics />
        </div>
    </div>
  );
}
