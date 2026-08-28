'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { timeAgo } from '../lib/ui';
import { csrfFetch } from '../lib/csrf-client';

interface Status {
  connected: boolean;
  mode: string;
  connectionMode: string | null;
  displayName: string | null;
  connectedAt: string | null;
  listeningTo: string[];
  lastEvent: { eventType: string; receivedAt?: string; createdAt?: string; status?: string } | null;
  recentEvents: Array<{ eventType: string; status: string; receivedAt: string }>;
  totalEvents: number;
}

export default function ConnectRazorpayCard({ initial }: { initial: Status | null }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(initial);
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  async function refresh() {
    const res = await fetch('/api/integrations/razorpay');
    setStatus(await res.json());
    router.refresh();
  }

  async function post(payload: Record<string, unknown>, busyLabel: string) {
    setBusy(busyLabel);
    setMessage(null);
    try {
      const res = await csrfFetch('/api/integrations/razorpay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `Failed (${res.status})`);
      return j;
    } finally {
      setBusy(null);
    }
  }

  async function connect(live: boolean) {
    try {
      await post(
        {
          action: 'connect',
          live,
          keyId: keyId || undefined,
          keySecret: keySecret || undefined,
        },
        live ? 'connect-live' : 'connect-demo'
      );
      setMessage({
        tone: 'ok',
        text: live
          ? 'Connection saved. Live webhook signatures are now strictly verified.'
          : 'Razorpay connected ✓' +
            (keySecret ? ' Keys stored encrypted — API sync enabled.' : ' Simulated events will be accepted.'),
      });
      setKeySecret('');
      await refresh();
    } catch (e) {
      setMessage({ tone: 'err', text: (e as Error).message });
    }
  }

  async function disconnect() {
    try {
      await post({ action: 'disconnect' }, 'disconnect');
      setMessage({ tone: 'ok', text: 'Disconnected.' });
      await refresh();
    } catch (e) {
      setMessage({ tone: 'err', text: (e as Error).message });
    }
  }

  async function test() {
    try {
      const j = await post({ action: 'test' }, 'test');
      setMessage({
        tone: 'ok',
        text: j.connected
          ? `Connection successful ✓ (${j.latencyMs}ms)${
              j.lastEvent ? ` — last event: ${j.lastEvent.eventType}` : ''
            }`
          : 'Not connected yet.',
      });
      await refresh();
    } catch (e) {
      setMessage({ tone: 'err', text: (e as Error).message });
    }
  }

  async function sync() {
    setBusy('sync');
    setMessage(null);
    try {
      const res = await csrfFetch('/api/integrations/razorpay/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 100 }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `Sync failed (${res.status})`);
      const failed = j.byStatus?.failed ?? 0;
      setMessage({
        tone: 'ok',
        text: `Synced ${j.fetched} payments (${failed} failed) → ${j.processed} processed, ${j.casesCreated} new recovery cases, ${j.actionsCreated} actions decided.`,
      });
      await refresh();
    } catch (e) {
      setMessage({ tone: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const connected = Boolean(status?.connected);

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 bg-gray-50 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-gray-900">Razorpay</span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                connected ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'
              }`}
            >
              {connected ? `Connected ✓ · ${status?.connectionMode === 'live' ? 'LIVE' : 'Test Mode'}` : 'Not Connected'}
            </span>
          </div>
        </div>
      </div>

      <div className="grid gap-5 p-5 lg:grid-cols-2">
        {/* Left: connection details */}
        <div>
          <dl className="space-y-2 text-sm">
            <Row label="Key ID" value={connected ? status?.displayName || '—' : '—'} mono />
            <Row label="Key Secret" value={connected ? '••••••••••••••••' : '—'} />
            <Row label="Mode" value={status?.connectionMode === 'live' ? 'Live (strict signature verification)' : status?.mode ? `Demo (${status.mode})` : '—'} />
            <Row label="Connected" value={status?.connectedAt ? timeAgo(status.connectedAt) : '—'} />
            <Row
              label="Last Event"
              value={
                status?.lastEvent
                  ? `${status.lastEvent.eventType}${status.lastEvent.receivedAt ? ` · ${timeAgo(status.lastEvent.receivedAt)}` : ''}`
                  : connected
                    ? 'Listening…'
                    : '—'
              }
              mono
            />
            <Row label="Total events ingested" value={String(status?.totalEvents ?? 0)} />
          </dl>

          <p className="mt-3 text-xs text-gray-400">Webhook URL</p>
          <code className="mt-1 block truncate rounded bg-gray-100 px-2 py-1.5 text-xs text-gray-700">
            {typeof window !== 'undefined'
              ? `${window.location.origin}/api/webhooks/razorpay`
              : '/api/webhooks/razorpay'}
          </code>

          {/* Listening checklist */}
          <p className="mt-4 text-xs font-medium uppercase tracking-wide text-gray-400">
            Listening for
          </p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {(status?.listeningTo || []).map((e) => (
              <li key={e} className={connected ? 'text-green-700' : 'text-gray-400'}>
                {connected ? '✓' : '○'} {e}
              </li>
            ))}
          </ul>

          {message && (
            <p
              className={`mt-3 rounded p-2 text-xs ${
                message.tone === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}
            >
              {message.text}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {!connected ? (
              <>
                <button
                  onClick={() => connect(false)}
                  disabled={busy !== null}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
                >
                  {busy === 'connect-demo' ? 'Connecting…' : 'Connect Razorpay Test Account'}
                </button>
                <button
                  onClick={() => connect(true)}
                  disabled={busy !== null || !keyId || !keySecret}
                  title={!keyId || !keySecret ? 'Enter a Key ID and Secret first' : undefined}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Connect with Live Keys
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={test}
                  disabled={busy !== null}
                  className="rounded-lg border border-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                >
                  {busy === 'test' ? 'Testing…' : 'Test Connection'}
                </button>
                <button
                  onClick={sync}
                  disabled={busy !== null}
                  title="Pull recent payments from the Razorpay REST API using your stored keys"
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                >
                  {busy === 'sync' ? 'Syncing…' : '⬇ Sync Failed Payments'}
                </button>
                <button
                  onClick={disconnect}
                  disabled={busy !== null}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>

          {!connected && (
            <details className="mt-4 text-xs text-gray-500">
              <summary className="cursor-pointer font-medium text-gray-600">
                Have real keys (test or live)? Enter them here — stored AES-256 encrypted, enables API sync
              </summary>
              <div className="mt-2 space-y-2">
                <input
                  value={keyId}
                  onChange={(e) => setKeyId(e.target.value)}
                  placeholder="rzp_test_xxxxxxxxxxxx"
                  className="w-full rounded border border-gray-300 px-3 py-1.5 font-mono text-xs"
                />
                <input
                  value={keySecret}
                  onChange={(e) => setKeySecret(e.target.value)}
                  type="password"
                  placeholder="Key secret (stored server-side, never rendered)"
                  className="w-full rounded border border-gray-300 px-3 py-1.5 font-mono text-xs"
                />
              </div>
            </details>
          )}
        </div>

        {/* Right: event flow diagram */}
        <div className="rounded-lg bg-slate-950 p-5 text-slate-100">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
            Event flow
          </p>
          <div className="mt-4 space-y-3 text-sm">
            <FlowStep title="Razorpay" sub="payment.failed / payment.captured …" icon="💳" active={connected} />
            <Arrow label="signed webhook" active={connected} />
            <FlowStep title="RevenuePulse ingestion" sub="signature check → durable idempotency row" icon="🛡️" active={connected} />
            <Arrow label="async job" active={connected} />
            <FlowStep title="AI Recovery System" sub="diagnose → predict → decide under policy → act" icon="🧠" active={connected} />
            <Arrow label="verify outcome" active={connected} />
            <FlowStep title="₹ recovered on your dashboard" sub="measured net of intervention cost" icon="📈" active={connected && (status?.totalEvents ?? 0) > 0} />
          </div>

          {status?.recentEvents?.length > 0 && (
            <div className="mt-5 border-t border-slate-800 pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Recent events
              </p>
              <ul className="mt-2 space-y-1 font-mono text-xs text-slate-400">
                {status.recentEvents.map((e, i) => (
                  <li key={i}>
                    <span className="text-emerald-400">{e.eventType}</span>{' '}
                    <span className="text-slate-500">{e.status.toLowerCase()}</span>{' '}
                    {timeAgo(e.receivedAt)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="w-40 shrink-0 text-gray-500">{label}</dt>
      <dd className={`truncate text-gray-900 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </>
  );
}

function FlowStep({ title, sub, icon, active }: { title: string; sub: string; icon: string; active: boolean }) {
  return (
    <div className={`flex items-center gap-3 rounded-lg border p-3 ${active ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-slate-800 bg-slate-900 opacity-50'}`}>
      <span className="text-xl">{icon}</span>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-xs text-slate-400">{sub}</p>
      </div>
    </div>
  );
}

function Arrow({ label, active }: { label: string; active: boolean }) {
  return (
    <div className={`flex items-center gap-2 pl-6 text-xs ${active ? 'text-emerald-400' : 'text-slate-600 opacity-50'}`}>
      <span>↓</span>
      <span>{label}</span>
    </div>
  );
}
