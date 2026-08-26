import AppNav from '../../components/app-nav';
import ReceivablesDashboard from '../../components/receivables-dashboard';

export const dynamic = 'force-dynamic';

export default function ReceivablesPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <AppNav />
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
          B2B Receivables
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Track invoice aging, collection priorities, and payment plans.
        </p>
        <div className="mt-6">
          <ReceivablesDashboard />
        </div>
      </div>
    </div>
  );
}
