// Policies - the guardrails every recovery decision must respect
import AppNav from '../../components/app-nav';
import PolicyForm from '../../components/policy-form';

export const metadata = { title: 'Policies — RevenuePulse' };

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-slate-950">
      <AppNav />
      <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-100">Policies &amp; Guardrails</h1>
        <p className="mb-6 mt-1 text-sm text-slate-400">
          Every AI decision passes through these merchant-configurable limits before any
          customer-facing action can fire.
        </p>

        <PolicyForm />

        <p className="mt-6 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-xs text-blue-300">
          These values are enforced by the decision engine on every case (see{' '}
          <code>packages/policies/src/decision-engine.ts</code>) and snapshotted into each
          RecoveryAction&apos;s audit record at decision time. Saved overrides live under{' '}
          <code>Merchant.settings.recoveryPolicy</code>.
        </p>
      </div>
    </div>
  );
}
