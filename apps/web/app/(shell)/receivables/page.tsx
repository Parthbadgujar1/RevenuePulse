import ReceivablesDashboard from '../../../components/receivables-dashboard';

export const dynamic = 'force-dynamic';

export default function ReceivablesPage() {
  return (
    <div className="mx-auto max-w-6xl">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-100">
          B2B Receivables
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Track invoice aging, collection priorities, and payment plans.
        </p>
        <div className="mt-6">
          <ReceivablesDashboard />
        </div>
    </div>
  );
}
