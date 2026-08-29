'use client';

import { useEffect, useState } from 'react';

interface RetryAttempt {
  attemptNumber: number;
  status: string;
  executedAt: string | null;
  nextRetryAt: string | null;
  failureCategory: string;
}

interface RetrySchedule {
  caseId: string;
  failureCategory: string;
  retryWindowMinutes: number;
  maxRetries: number;
  currentRetry: number;
  nextRetryAt: string | null;
  status: string;
  attempts: RetryAttempt[];
}

export default function RetryScheduleViewer({ caseId }: { caseId: string }) {
  const [schedule, setSchedule] = useState<RetrySchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/cases/${caseId}/retry-schedule`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`);
        return r.json();
      })
      .then((d) => setSchedule(d.schedule))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [caseId]);

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400 shadow-sm">
        Loading retry schedule…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300 shadow-sm">
        {error}
      </div>
    );
  }

  if (!schedule) return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-100">Retry Schedule</p>
      <p className="mt-3 text-sm text-slate-400">No retry schedule configured for this case.</p>
    </div>
  );

  const statusTone: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-300',
    executed: 'bg-emerald-500/15 text-emerald-300',
    failed: 'bg-red-500/15 text-red-300',
    scheduled: 'bg-blue-500/15 text-blue-300',
    completed: 'bg-slate-800 text-slate-400',
    active: 'bg-blue-500/15 text-blue-300',
  };

  const categoryLabels: Record<string, string> = {
    NETWORK_FAILURE: 'Network failure',
    INSUFFICIENT_FUNDS: 'Insufficient funds',
    CARD_DECLINED: 'Card declined',
    BANK_TIMEOUT: 'Bank timeout',
    FRAUD_SUSPECTED: 'Fraud suspected',
    EXPIRED_CARD: 'Expired card',
    GENERIC: 'Generic',
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-100">Retry Schedule</p>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusTone[schedule.status] ?? 'bg-slate-800 text-slate-400'}`}>
            {schedule.status}
          </span>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Failure Category</p>
            <p className="mt-1 text-sm font-medium text-slate-100">
              {categoryLabels[schedule.failureCategory] ?? schedule.failureCategory}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Retry Window</p>
            <p className="mt-1 text-sm text-slate-200">{schedule.retryWindowMinutes} minutes</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Current Retry</p>
            <p className="mt-1 text-sm text-slate-200">{schedule.currentRetry} of {schedule.maxRetries}</p>
          </div>
          {schedule.nextRetryAt && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Next Retry</p>
              <p className="mt-1 text-sm text-slate-200">
                {new Date(schedule.nextRetryAt).toLocaleString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Timeline</p>

        <div className="mt-4 relative">
          <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-slate-700" />

          <div className="space-y-4">
            {schedule.attempts.map((attempt) => (
              <div key={attempt.attemptNumber} className="relative flex gap-4">
                <div className={`z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-2 ${
                  attempt.status === 'executed'
                    ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                    : attempt.status === 'failed'
                      ? 'bg-red-500/15 text-red-300 ring-red-500/30'
                      : 'bg-amber-500/10 text-amber-300 ring-amber-500/30'
                }`}>
                  {attempt.attemptNumber}
                </div>
                <div className="flex-1 pb-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-slate-100">Attempt {attempt.attemptNumber}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone[attempt.status] ?? 'bg-slate-800 text-slate-400'}`}>
                      {attempt.status}
                    </span>
                  </div>
                  {attempt.executedAt && (
                    <p className="mt-0.5 text-xs text-slate-400">
                      Executed {new Date(attempt.executedAt).toLocaleString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  )}
                  {attempt.nextRetryAt && (
                    <p className="mt-0.5 text-xs text-slate-400">
                      Next retry: {new Date(attempt.nextRetryAt).toLocaleString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  )}
                </div>
              </div>
            ))}

            {schedule.attempts.length === 0 && (
              <p className="ml-8 text-sm text-slate-400">No retry attempts recorded yet.</p>
            )}

            {schedule.currentRetry < schedule.maxRetries && schedule.nextRetryAt && (
              <div className="relative flex gap-4">
                <div className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-slate-700 bg-slate-900 text-xs font-bold text-slate-500">
                  ?
                </div>
                <div className="flex-1 pb-2">
                  <p className="text-sm font-medium text-slate-500">Upcoming retry</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Scheduled for {new Date(schedule.nextRetryAt!).toLocaleString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
