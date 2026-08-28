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

export default function PolicyForm() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [hasOverrides, setHasOverrides] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

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
        setMessage({ ok: true, text: 'Policy saved — applied to every new decision immediately.' });
      }
    } catch {
      setMessage({ ok: false, text: 'Network error while saving.' });
    } finally {
      setSaving(false);
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
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
        Loading policy…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <label className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-gray-900">Autonomous execution</p>
            <p className="text-xs text-gray-500">
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

      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-gray-900">Stopping rules</p>
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

      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-gray-900">Allowed interventions</p>
        <p className="text-xs text-gray-500">
          The decision engine only considers these when picking an action.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {ALL_INTERVENTIONS.map((i) => (
            <label key={i.value} className="flex items-center gap-2 text-sm text-gray-700">
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
              ? 'border-green-300 bg-green-50 text-green-800'
              : 'border-red-300 bg-red-50 text-red-800'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !policy}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save policy'}
        </button>
        {hasOverrides && (
          <button
            onClick={resetDefaults}
            disabled={saving}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Reset to defaults
          </button>
        )}
        <span className="text-xs text-gray-400">Applied live — no redeploy needed.</span>
      </div>
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
      <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">{label}</label>
      <input type="number" step={step} {...input} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <p className="mt-0.5 text-xs font-medium text-emerald-700">
        Now: {hint}
        {note && <span className="ml-1 font-normal text-gray-400">({note})</span>}
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
    <label className="flex items-center justify-between gap-4 rounded-lg border border-gray-100 px-3 py-2 hover:bg-gray-50">
      <div>
        <p className="text-sm text-gray-800">{label}</p>
        <p className="text-xs text-gray-500">{note}</p>
      </div>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="h-5 w-5 accent-emerald-600" />
    </label>
  );
}
