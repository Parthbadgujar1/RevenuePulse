import AppNav from '../../components/app-nav';
import RecoveryAnalytics from '../../components/recovery-analytics';

export const dynamic = 'force-dynamic';

export default function AnalyticsPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <AppNav />
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
          Recovery Analytics
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Recovery rates by payment method, gateway, failure reason, and region.
        </p>
        <div className="mt-6">
          <RecoveryAnalytics />
        </div>
      </div>
    </div>
  );
}
