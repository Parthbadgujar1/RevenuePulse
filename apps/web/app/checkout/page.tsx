import AppNav from '../../components/app-nav';
import CheckoutRecoveryPanel from '../../components/checkout-recovery-panel';

export const dynamic = 'force-dynamic';

export default function CheckoutPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <AppNav />
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
          Checkout Abandonment Recovery
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Detect and recover abandoned checkout sessions with targeted incentives.
        </p>
        <div className="mt-6">
          <CheckoutRecoveryPanel />
        </div>
      </div>
    </div>
  );
}
