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
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
        Loading retry schedule…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700 shadow-sm">
        {error}
      </div>
    );
  }

  if (!schedule) return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-gray-900">Retry Schedule</p>
      <p className="mt-3 text-sm text-gray-500">No retry schedule configured for this case.</p>
    </div>
  );

  const statusTone: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-800',
    executed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    scheduled: 'bg-blue-100 text-blue-800',
    completed: 'bg-gray-100 text-gray-600',
    active: 'bg-blue-100 text-blue-800',
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
      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-900">Retry Schedule</p>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusTone[schedule.status] ?? 'bg-gray-100 text-gray-600'}`}>
            {schedule.status}
          </span>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Failure Category</p>
            <p className="mt-1 text-sm font-medium text-gray-900">
              {categoryLabels[schedule.failureCategory] ?? schedule.failureCategory}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Retry Window</p>
            <p className="mt-1 text-sm text-gray-800">{schedule.retryWindowMinutes} minutes</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Current Retry</p>
            <p className="mt-1 text-sm text-gray-800">{schedule.currentRetry} of {schedule.maxRetries}</p>
          </div>
          {schedule.nextRetryAt && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Next Retry</p>
              <p className="mt-1 text-sm text-gray-800">
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

      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Timeline</p>

        <div className="mt-4 relative">
          <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />

          <div className="space-y-4">
            {schedule.attempts.map((attempt) => (
              <div key={attempt.attemptNumber} className="relative flex gap-4">
                <div className={`z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-2 ${
                  attempt.status === 'executed'
                    ? 'bg-green-100 text-green-700 ring-green-200'
                    : attempt.status === 'failed'
                      ? 'bg-red-100 text-red-700 ring-red-200'
                      : 'bg-amber-100 text-amber-700 ring-amber-200'
                }`}>
                  {attempt.attemptNumber}
                </div>
                <div className="flex-1 pb-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">Attempt {attempt.attemptNumber}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone[attempt.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {attempt.status}
                    </span>
                  </div>
                  {attempt.executedAt && (
                    <p className="mt-0.5 text-xs text-gray-500">
                      Executed {new Date(attempt.executedAt).toLocaleString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  )}
                  {attempt.nextRetryAt && (
                    <p className="mt-0.5 text-xs text-gray-500">
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
              <p className="ml-8 text-sm text-gray-500">No retry attempts recorded yet.</p>
            )}

            {schedule.currentRetry < schedule.maxRetries && schedule.nextRetryAt && (
              <div className="relative flex gap-4">
                <div className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-gray-300 bg-white text-xs font-bold text-gray-400">
                  ?
                </div>
                <div className="flex-1 pb-2">
                  <p className="text-sm font-medium text-gray-400">Upcoming retry</p>
                  <p className="mt-0.5 text-xs text-gray-400">
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
