// Policies - the guardrails every recovery decision must respect
import AppNav from '../../components/app-nav';
import { inr } from '../../lib/ui';

export const metadata = { title: 'Policies — RevenuePulse' };

const POLICY = [
  { key: 'maximumRetryCount', label: 'Max retries per case', value: '3', note: 'Hard ceiling — no customer is retried beyond this.' },
  { key: 'maximumContactCount', label: 'Max customer contacts', value: '2', note: 'Dunning/reminder messages per case.' },
  { key: 'cooldownPeriod', label: 'Cooldown between attempts', value: '24 hours', note: 'Prevents aggressive back-to-back retries.' },
  { key: 'maximumCaseLifetime', label: 'Case lifetime', value: '30 days', note: 'Cases auto-close after this window.' },
  { key: 'minimumRecoveryProbability', label: 'Min AI recovery probability', value: '20%', note: 'Below this, the agent refuses to act.' },
  { key: 'minimumExpectedNetRecovery', label: 'Min expected net recovery', value: inr(100), note: 'Expected value must clear this bar after costs. DO_NOTHING baseline is always ₹0.' },
  { key: 'humanApprovalThreshold', label: 'Human approval above', value: inr(1000000), note: 'High-value cases wait for a human before any action fires.' },
  { key: 'maximumIncentivePercentage', label: 'Max incentive', value: '10% of amount', note: 'Caps discounts offered during recovery.' },
  { key: 'stopOnCustomerDecline', label: 'Stop on customer decline', value: 'Enabled', note: 'Opt-outs halt all interventions immediately.' },
  { key: 'stopOnRepeatedFailure', label: 'Stop on repeated failure', value: 'Enabled', note: 'A stopping rule — repeated failed attempts end the case.' },
  { key: 'stopOnPolicyViolation', label: 'Stop on policy violation', value: 'Enabled', note: 'Any violation forces DO_NOTHING with an audit entry.' },
  { key: 'autoActionEnable', label: 'Autonomous execution', value: 'Enabled below approval threshold', note: 'Low-risk actions execute automatically; everything else queues for approval.' },
];

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <AppNav />
      <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Policies & Guardrails</h1>
        <p className="mb-6 mt-1 text-sm text-gray-500">
          Every AI decision passes through these merchant-configurable limits before any
          customer-facing action can fire.
        </p>

        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-gray-100">
              {POLICY.map((p) => (
                <tr key={p.key} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-800">{p.label}</td>
                  <td className="whitespace-nowrap px-5 py-3 font-semibold text-emerald-700">{p.value}</td>
                  <td className="px-5 py-3 text-xs text-gray-500">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
          These values are enforced by the decision engine on every case (see
          <code className="mx-1">packages/policies/src/decision-engine.ts</code>) and snapshotted into
          each RecoveryAction&apos;s audit record at decision time.
        </p>
      </div>
    </div>
  );
}
