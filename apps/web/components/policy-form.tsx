'use client';

import { useEffect, useState } from 'react';
import { inr } from '../lib/ui';
import { csrfFetch } from '../lib/csrf-client';

interface Policy {
  autoActionEnable: boolean;
  stopOnCustomerDecline: boolean;
  stopOnRepeatedFailure: boolean;
  stopOnPolicyViolation: boolean;
  maximumIncentivePercentage: number;
  maximumIncentiveAmount: number;
  maximumRecoveryValue: number;
  maximumRetryCount: number;
  maximumContactCount: number;
  minimumRecoveryProbability: number;
  minimumExpectedNetRecovery: number;
  humanApprovalThreshold: number;
  cooldownPeriod: number;
  maximumCaseLifetime: number;
  allowedInterventionTypes: string[];
}

const ALL_INTERVENTIONS = [
  { value: 'retry_later', label: 'Retry later' },
  { value: 'timed_reminder', label: 'Timed reminder' },
  { value: 'payment_method_recovery', label: 'Payment-method recovery' },
  { value: 'checkout_recovery', label: 'Checkout recovery' },
  { value: 'subscription_recovery', label: 'Subscription recovery' },
  { value: 'human_escalation', label: 'Human escalation' },
];

interface SimulationAggregate {
  cases: number;
  byAction: Record<string, number>;
  requiresApproval: number;
  stoppedByPolicy: number;
  projectedNetRecovery: number;
  projectedActions: number;
}

interface SimulationResult {
  sampled: number;
  evaluated: number;
  current: SimulationAggregate;
  candidate: SimulationAggregate;
  delta: {
    projectedNetRecovery: number;
    requiresApproval: number;
    stoppedByPolicy: number;
    projectedActions: number;
  };
  flippedCases: { caseRef: string | null; from: string; to: string; amount: number }[];
  flippedCount: number;
}

export default function PolicyForm() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [hasOverrides, setHasOverrides] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);

  useEffect(() => {
    fetch('/api/settings/policy')
      .then((r) => r.json())
      .then((d) => {
        setPolicy(d.policy);
        setHasOverrides(d.hasOverrides);
      })
      .catch(() => setMessage({ ok: false, text: 'Could not load policy.' }));
  }, []);

  function num<K extends keyof Policy>(key: K) {
    return {
      value: String(policy?.[key] ?? ''),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setPolicy((p) => (p ? { ...p, [key]: Number(e.target.value) } : p)),
      disabled: saving || !policy,
    };
  }

  function bool(key: keyof Policy) {
    return {
      checked: Boolean(policy?.[key]),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setPolicy((p) => (p ? { ...p, [key]: e.target.checked } : p)),
      disabled: saving || !policy,
    };
  }

  function toggleIntervention(v: string) {
    setPolicy((p) => {
      if (!p) return p;
      const has = p.allowedInterventionTypes.includes(v);
      // do_nothing is always implicitly allowed; keep at least one active intervention
      if (v !== 'do_nothing' && has && p.allowedInterventionTypes.filter((t) => t !== 'do_nothing').length === 1) {
        return p;
      }
      return {
        ...p,
        allowedInterventionTypes: has
          ? p.allowedInterventionTypes.filter((t) => t !== v)
          : [...p.allowedInterventionTypes, v],
      };
    });
  }

  async function save() {
    if (!policy) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await csrfFetch('/api/settings/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      });
      const d = await res.json();
      if (!res.ok) {
        const details = Array.isArray(d.details) ? ` (${d.details.join('; ')})` : '';
        setMessage({ ok: false, text: `${d.error ?? 'Save failed'}${details}` });
      } else {
        setPolicy(d.effectivePolicy);
        setHasOverrides(true);
        setSimulation(null);
        setMessage({ ok: true, text: 'Policy saved — applied to every new decision immediately.' });
      }
    } catch {
      setMessage({ ok: false, text: 'Network error while saving.' });
    } finally {
      setSaving(false);
    }
  }

  async function simulate() {
    if (!policy) return;
    setSimulating(true);
    setSimError(null);
    try {
      const res = await csrfFetch('/api/settings/policy/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy, sampleSize: 200 }),
      });
      const d = await res.json();
      if (!res.ok) {
        const details = Array.isArray(d.details) ? ` (${d.details.join('; ')})` : '';
        setSimError(`${d.error ?? 'Simulation failed'}${details}`);
        setSimulation(null);
      } else {
        setSimulation(d);
      }
    } catch {
      setSimError('Network error while simulating.');
      setSimulation(null);
    } finally {
      setSimulating(false);
    }
  }

  async function resetDefaults() {
    if (!policy) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await csrfFetch('/api/settings/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await res.json();
      if (res.ok) {
        setPolicy(d.effectivePolicy);
        setHasOverrides(false);
        setSimulation(null);
        setMessage({ ok: true, text: 'Restored platform defaults.' });
      } else {
        setMessage({ ok: false, text: d.error ?? 'Reset failed' });
      }
    } finally {
      setSaving(false);
    }
  }

  if (!policy) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400 shadow-sm">
        Loading policy…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
        <label className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-100">Autonomous execution</p>
            <p className="text-xs text-slate-400">
              When off, every action queues for human approval regardless of amount.
            </p>
          </div>
          <input type="checkbox" {...bool('autoActionEnable')} className="h-5 w-5 accent-emerald-600" />
        </label>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Human approval above"
            hint={inr(policy.humanApprovalThreshold)}
            note="Amount in paise"
            {...num('humanApprovalThreshold')}
          />
          <NumberField
            label="Max retries per case"
            hint={`${policy.maximumRetryCount} attempts`}
            note="0–10"
            {...num('maximumRetryCount')}
          />
          <NumberField
            label="Min AI recovery probability"
            hint={`${(policy.minimumRecoveryProbability * 100).toFixed(0)}%`}
            note="0.01–1"
            step="0.01"
            {...num('minimumRecoveryProbability')}
          />
          <NumberField
            label="Min expected net recovery"
            hint={inr(policy.minimumExpectedNetRecovery)}
            note="Paise"
            {...num('minimumExpectedNetRecovery')}
          />
          <NumberField
            label="Cooldown between attempts"
            hint={`${policy.cooldownPeriod} hours`}
            note="0–720"
            {...num('cooldownPeriod')}
          />
          <NumberField
            label="Case lifetime"
            hint={`${policy.maximumCaseLifetime} days`}
            note="1–365"
            {...num('maximumCaseLifetime')}
          />
          <NumberField
            label="Max contacts per case"
            hint={`${policy.maximumContactCount} messages`}
            note="0–10"
            {...num('maximumContactCount')}
          />
          <NumberField
            label="Max incentive"
            hint={`${policy.maximumIncentivePercentage}% of amount`}
            note="0–100"
            {...num('maximumIncentivePercentage')}
          />
          <NumberField
            label="Max incentive amount (paise)"
            hint={inr(policy.maximumIncentiveAmount)}
            note="Paise"
            {...num('maximumIncentiveAmount')}
          />
          <NumberField
            label="Max recovery value (paise)"
            hint={inr(policy.maximumRecoveryValue)}
            note="Paise"
            {...num('maximumRecoveryValue')}
          />
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
        <p className="text-sm font-semibold text-slate-100">Stopping rules</p>
        <div className="mt-3 space-y-2">
          <ToggleRow
            label="Stop on customer decline"
            note="Customer opt-outs halt all interventions immediately."
            {...bool('stopOnCustomerDecline')}
          />
          <ToggleRow
            label="Stop on repeated failure"
            note="Repeated failed attempts end the case."
            {...bool('stopOnRepeatedFailure')}
          />
          <ToggleRow
            label="Stop on policy violation"
            note="Any violation forces DO_NOTHING with an audit entry."
            {...bool('stopOnPolicyViolation')}
          />
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
        <p className="text-sm font-semibold text-slate-100">Allowed interventions</p>
        <p className="text-xs text-slate-400">
          The decision engine only considers these when picking an action.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {ALL_INTERVENTIONS.map((i) => (
            <label key={i.value} className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={policy.allowedInterventionTypes.includes(i.value)}
                onChange={() => toggleIntervention(i.value)}
                disabled={saving}
                className="h-4 w-4 accent-emerald-600"
              />
              {i.label}
            </label>
          ))}
        </div>
      </div>

      {message && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            message.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !policy}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save policy'}
        </button>
        <button
          onClick={simulate}
          disabled={simulating || !policy}
          className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-300 transition hover:bg-blue-500/20 disabled:opacity-50"
        >
          {simulating ? 'Simulating…' : 'Simulate impact'}
        </button>
        {hasOverrides && (
          <button
            onClick={resetDefaults}
            disabled={saving}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-900 disabled:opacity-50"
          >
            Reset to defaults
          </button>
        )}
        <span className="text-xs text-slate-500">Applied live — no redeploy needed.</span>
      </div>

      <PolicySimulationPanel error={simError} result={simulation} />
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  retry_later: 'Retry later',
  timed_reminder: 'Timed reminder',
  payment_method_recovery: 'Payment-method recovery',
  checkout_recovery: 'Checkout recovery',
  subscription_recovery: 'Subscription recovery',
  human_escalation: 'Human escalation',
  do_nothing: 'Do nothing',
};

function humanizeAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function signedInr(paise: number): string {
  const sign = paise > 0 ? '+' : paise < 0 ? '−' : '';
  return `${sign}${inr(Math.abs(paise))}`;
}

function PolicySimulationPanel({
  error,
  result,
}: {
  error: string | null;
  result: SimulationResult | null;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
        {error}
      </div>
    );
  }
  if (!result) return null;

  if (result.evaluated === 0) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
        No scored cases yet to simulate against — run a Demo Lab batch or bring in real payment
        data first, then preview policy changes here.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-5">
      <p className="text-sm font-semibold text-slate-100">
        What-if preview — replayed against your last {result.evaluated} scored cases
      </p>
      <p className="mt-1 text-xs text-slate-400">
        Read-only: the decision engine re-runs on real, already-recorded predictions. Nothing is
        executed or saved until you click &quot;Save policy&quot;.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <SimStat
          label="Projected net recovery"
          value={signedInr(result.delta.projectedNetRecovery)}
          positiveIsGood
          delta={result.delta.projectedNetRecovery}
        />
        <SimStat
          label="Cases needing approval"
          value={signed(result.delta.requiresApproval)}
          positiveIsGood={false}
          delta={result.delta.requiresApproval}
        />
        <SimStat
          label="Stopped by policy"
          value={signed(result.delta.stoppedByPolicy)}
          positiveIsGood={false}
          delta={result.delta.stoppedByPolicy}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ActionMix title="Current policy" aggregate={result.current} />
        <ActionMix title="Candidate policy" aggregate={result.candidate} />
      </div>

      {result.flippedCount > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            {result.flippedCount} case{result.flippedCount === 1 ? '' : 's'} would change action
          </p>
          <ul className="mt-2 space-y-1 text-xs text-slate-400">
            {result.flippedCases.map((f, i) => (
              <li key={i}>
                {f.caseRef ?? 'case'} · {inr(f.amount)} · {humanizeAction(f.from)} →{' '}
                <span className="text-blue-300">{humanizeAction(f.to)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SimStat({
  label,
  value,
  delta,
  positiveIsGood,
}: {
  label: string;
  value: string;
  delta: number;
  positiveIsGood: boolean;
}) {
  const neutral = delta === 0;
  const good = positiveIsGood ? delta > 0 : delta < 0;
  const color = neutral ? 'text-slate-300' : good ? 'text-emerald-300' : 'text-amber-300';
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function ActionMix({ title, aggregate }: { title: string; aggregate: SimulationAggregate }) {
  const entries = Object.entries(aggregate.byAction).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <p className="text-xs font-semibold text-slate-300">{title}</p>
      <ul className="mt-2 space-y-1 text-xs text-slate-400">
        {entries.map(([action, count]) => (
          <li key={action} className="flex justify-between">
            <span>{humanizeAction(action)}</span>
            <span className="text-slate-300">{count}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 border-t border-slate-800 pt-2 text-xs text-slate-500">
        {aggregate.requiresApproval} need approval · {aggregate.stoppedByPolicy} stopped
      </p>
    </div>
  );
}

function NumberField({
  label,
  hint,
  note,
  step,
  ...input
}: {
  label: string;
  hint: string;
  note?: string;
  step?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</label>
      <input type="number" step={step} {...input} className="mt-1 w-full rounded-lg border border-slate-700 px-3 py-2 text-sm" />
      <p className="mt-0.5 text-xs font-medium text-emerald-300">
        Now: {hint}
        {note && <span className="ml-1 font-normal text-slate-500">({note})</span>}
      </p>
    </div>
  );
}

function ToggleRow({
  label,
  note,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  note: string;
  checked: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 px-3 py-2 hover:bg-slate-900">
      <div>
        <p className="text-sm text-slate-200">{label}</p>
        <p className="text-xs text-slate-400">{note}</p>
      </div>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="h-5 w-5 accent-emerald-600" />
    </label>
  );
}
