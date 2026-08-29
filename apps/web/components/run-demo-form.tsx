'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { inr } from '../lib/ui';
import { csrfFetch } from '../lib/csrf-client';

const FAILURE_OPTIONS = [
  { code: 'INSUFFICIENT_FUNDS', label: 'Insufficient Funds' },
  { code: 'RA0014', label: 'Bank Failure' },
  { code: 'TIMEOUT', label: 'Network Timeout' },
  { code: 'CARD_EXPIRED', label: 'Expired Payment Method' },
  { code: 'AUTH_ERROR', label: 'Authentication Failure' },
  { code: 'REPEATED_ATTEMPT', label: 'Repeated Failure' },
];

const PRESETS: Record<string, string[]> = {
  'Mixed Batch': FAILURE_OPTIONS.map((f) => f.code),
  'Insufficient Funds Recovery': ['INSUFFICIENT_FUNDS', 'TIMEOUT'],
  'Authentication Failure': ['AUTH_ERROR', 'CARD_EXPIRED'],
  'Network Timeout': ['TIMEOUT', 'RA0014'],
};

interface StageState {
  label: string;
  total: number;
  done: number;
  complete: boolean;
}

interface Results {
  cohortSize: number;
  datasetLabel?: string;
  seed?: number;
  funnel: Record<string, number>;
  money: { atRisk: number; recovered: number; cost: number; net: number; recoveryRatePct: number };
  strategies: {
    noIntervention: { net: number; recovered: number; cost: number };
    retryAll: { net: number; recovered: number; cost: number; note?: string };
    revenuePulse: { net: number; recovered: number; cost: number };
    upliftVsRetryAll: number;
  };
}

export default function RunDemoForm() {
  const [count, setCount] = useState(100);
  const [seed, setSeed] = useState(20260823);
  const [selected, setSelected] = useState<string[]>(FAILURE_OPTIONS.map((f) => f.code));
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [stageOrder, setStageOrder] = useState<string[]>([]);
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function toggle(code: string) {
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  async function run() {
    setRunning(true);
    setResults(null);
    setError(null);
    setStages({});
    setStageOrder([]);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await csrfFetch('/api/demo-lab/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, seed, failureCodes: selected }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Runner failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.type === 'stage') {
            setStageOrder((o) => (o.includes(evt.key) ? o : [...o, evt.key]));
            setStages((s) => ({
              ...s,
              [evt.key]: { label: evt.label, total: evt.total, done: 0, complete: false },
            }));
          } else if (evt.type === 'progress') {
            setStages((s) => ({
              ...s,
              [evt.key]: s[evt.key]
                ? { ...s[evt.key], done: evt.done }
                : { label: evt.key, total: evt.done, done: evt.done, complete: false },
            }));
          } else if (evt.type === 'stage_done') {
            setStages((s) => ({
              ...s,
              [evt.key]: s[evt.key]
                ? { ...s[evt.key], complete: true }
                : s[evt.key],
            }));
          } else if (evt.type === 'results') {
            setResults(evt.results);
          } else if (evt.type === 'error') {
            throw new Error(evt.message);
          }
        }
      }
      // mark all visible stages complete
      setStages((s) =>
        Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, complete: true }]))
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
        <h2 className="font-semibold text-slate-100">Run Recovery Simulation</h2>
        <p className="mt-1 text-sm text-slate-400">
          Generates synthetic failed payments and pushes them through the real pipeline — durable
          webhook ingestion, diagnosis, ML scoring, policy-checked decisions, bounded execution and
          outcome verification.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {Object.keys(PRESETS).map((name) => (
            <button
              key={name}
              onClick={() => setSelected(PRESETS[name])}
              disabled={running}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300 hover:border-emerald-400 hover:text-emerald-300 disabled:opacity-50"
            >
              {name}
            </button>
          ))}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-sm font-medium text-slate-300">Number of transactions</label>
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              disabled={running}
              className="mt-1 w-full rounded-lg border border-slate-700 px-3 py-2 text-sm"
            >
              {[25, 50, 100, 250].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-slate-300">
              Seed{' '}
              <span className="font-normal text-slate-500">(same seed = reproducible batch)</span>
            </label>
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value) || 20260823)}
              disabled={running}
              className="mt-1 w-full rounded-lg border border-slate-700 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <span className="text-sm font-medium text-slate-300">Failure distribution</span>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {FAILURE_OPTIONS.map((f) => (
                <label key={f.code} className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={selected.includes(f.code)}
                    onChange={() => toggle(f.code)}
                    disabled={running}
                    className="accent-emerald-600"
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={run}
          disabled={running || selected.length === 0}
          className="mt-4 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? 'Running…' : `Generate & Run Recovery on ${count} payments`}
        </button>
      </div>

      {/* Progress */}
      {(stageOrder.length > 0 || running) && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
          <h2 className="mb-3 font-semibold text-slate-100">Pipeline progress</h2>
          <ol className="space-y-3">
            {stageOrder.map((key) => {
              const st = stages[key];
              if (!st) return null;
              const pct = st.total > 0 ? Math.min(100, (st.done / st.total) * 100) : 0;
              return (
                <li key={key}>
                  <div className="flex justify-between text-xs">
                    <span className={st.complete ? 'font-medium text-emerald-300' : 'text-slate-300'}>
                      {st.complete ? '✓ ' : ''}
                      {st.label}
                    </span>
                    <span className="text-slate-500">
                      {Math.min(st.done, st.total)}/{st.total}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded bg-slate-800">
                    <div
                      className={`h-full rounded transition-all duration-300 ${
                        st.complete ? 'bg-emerald-500' : 'bg-blue-500'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="At risk" value={inr(results.money.atRisk)} tone="bg-blue-500" />
            <Kpi label="Recovered" value={inr(results.money.recovered)} tone="bg-emerald-500" />
            <Kpi label="Intervention cost" value={inr(results.money.cost)} tone="bg-orange-500" />
            <Kpi label="Net recovered" value={inr(results.money.net)} tone="bg-purple-500" />
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
            <h2 className="font-semibold text-slate-100">Recovery funnel</h2>
            <FunnelBar label="Failed payments ingested" n={results.funnel.ingested} of={results.cohortSize} />
            <FunnelBar label="Diagnosed" n={results.funnel.diagnosed} of={results.cohortSize} />
            <FunnelBar label="Eligible for recovery" n={results.funnel.eligible} of={results.cohortSize} />
            <FunnelBar label="Actions executed" n={results.funnel.executed} of={results.cohortSize} />
            <FunnelBar label="Outcomes verified" n={results.funnel.verified} of={results.cohortSize} />
            <FunnelBar label="Recovered" n={results.funnel.recovered} of={results.cohortSize} last />
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-800 pt-3 text-xs text-slate-400">
              <span>⏹ {results.funnel.stoppedByPolicyOrEconomics} stopped by policy/economics</span>
              <span>👤 {results.funnel.awaitingApproval} awaiting human approval</span>
              <span>
                ↩︎ {Math.max(0, results.funnel.verified - results.funnel.recovered)} attempts did not
                recover · {results.funnel.recovered}/{results.funnel.verified} succeeded
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
            <h2 className="font-semibold text-slate-100">Strategy comparison</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <StrategyCard
                title="No intervention"
                net={results.strategies.noIntervention.net}
                recovered={results.strategies.noIntervention.recovered}
                cost={results.strategies.noIntervention.cost}
              />
              <StrategyCard
                title="Retry everything once"
                net={results.strategies.retryAll.net}
                recovered={results.strategies.retryAll.recovered}
                cost={results.strategies.retryAll.cost}
                note={results.strategies.retryAll.note}
              />
              <StrategyCard
                title="RevenuePulse AI"
                net={results.strategies.revenuePulse.net}
                recovered={results.strategies.revenuePulse.recovered}
                cost={results.strategies.revenuePulse.cost}
                highlight
              />
            </div>
            {results.strategies.upliftVsRetryAll > 0 && (
              <p className="mt-3 rounded-lg bg-emerald-500/10 p-3 text-center text-sm font-semibold text-emerald-300">
                RevenuePulse nets {inr(results.strategies.upliftVsRetryAll)} more than retry-everything
                on this exact cohort — same ground-truth simulator, smarter targeting.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/dashboard"
              className="rounded-lg border border-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/10"
            >
              See it on the dashboard →
            </Link>
            <Link
              href="/cases"
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-900"
            >
              Investigate cases
            </Link>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`rounded-lg p-4 text-white shadow ${tone}`}>
      <div className="text-xl sm:text-2xl font-bold">{value}</div>
      <div className="text-sm opacity-90">{label}</div>
    </div>
  );
}

function FunnelBar({ label, n, of, last }: { label: string; n: number; of: number; last?: boolean }) {
  const pct = of > 0 ? (n / of) * 100 : 0;
  return (
    <div className={last ? '' : 'mb-2'}>
      <div className="flex justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-400">{n}</span>
      </div>
      <div className="mt-1 h-2 rounded bg-slate-800">
        <div
          className={`h-full rounded ${last ? 'bg-emerald-500' : 'bg-blue-500'}`}
          style={{ width: `${Math.max(pct, n > 0 ? 3 : 0)}%` }}
        />
      </div>
    </div>
  );
}

function StrategyCard({
  title,
  net,
  recovered,
  cost,
  highlight,
  note,
}: {
  title: string;
  net: number;
  recovered: number;
  cost: number;
  highlight?: boolean;
  note?: string;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        highlight ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-800 bg-slate-900'
      }`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{title}</p>
      <p className={`mt-1 text-xl font-bold ${highlight ? 'text-emerald-300' : 'text-slate-100'}`}>
        {inr(net)}
      </p>
      <p className="text-xs text-slate-400">net · recovered {inr(recovered)} · cost {inr(cost)}</p>
      {note && <p className="mt-1 text-[10px] uppercase tracking-wide text-slate-500">({note})</p>}
    </div>
  );
}
