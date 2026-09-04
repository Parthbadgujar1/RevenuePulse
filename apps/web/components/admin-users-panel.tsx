'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ShieldAlert, UserPlus } from 'lucide-react';
import { Badge } from './ui/badge';
import { useToast } from './ui/toast';
import { SectionTitle, EmptyState } from './ui/states';

interface AdminUser {
  id: string;
  name?: string | null;
  email: string;
  role: string;
  status: string;
  merchantId?: string | null;
  createdAt: string;
}

interface UsersResponse {
  success?: boolean;
  data?: AdminUser[];
  roles?: string[];
}

const ROLE_TONE: Record<string, 'purple' | 'info' | 'warning' | 'danger'> = {
  MERCHANT_OWNER: 'purple',
  FINANCE_MANAGER: 'info',
  SUPPORT_OPERATOR: 'warning',
  ADMIN: 'danger',
};

export function AdminUsersPanel() {
  const { toast } = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('FINANCE_MANAGER');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/users');
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const j = (await res.json()) as UsersResponse;
      setUsers(j.data ?? []);
      setRoles(j.roles ?? []);
    } catch {
      toast('error', 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, role }),
    });
    if (res.ok) {
      toast('success', 'User created');
      setName('');
      setEmail('');
      setPassword('');
      setRole('FINANCE_MANAGER');
      setShowForm(false);
      void load();
    } else {
      const j = await res.json().catch(() => ({}));
      toast('error', j?.error?.message ?? 'Could not create user');
    }
  };

  const updateStatus = async (id: string, status: string) => {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      toast('success', status === 'active' ? 'Account activated' : 'Account deactivated');
      void load();
    } else {
      toast('error', 'Update failed');
    }
  };

  if (forbidden) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger-ink">
        <ShieldAlert className="h-4 w-4" aria-hidden /> You do not have permission to manage users.
      </div>
    );
  }

  return (
    <div>
      <SectionTitle hint={users.length ? `${users.length} account${users.length === 1 ? '' : 's'}` : undefined}>
        Users &amp; access
      </SectionTitle>

      {!showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="mb-3 inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:bg-accent-strong"
        >
          <UserPlus className="h-4 w-4" aria-hidden /> Add user
        </button>
      )}

      {showForm && (
        <form onSubmit={create} className="mb-4 grid gap-3 rounded-xl border border-edge bg-surface p-4 sm:grid-cols-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="h-10 rounded-lg border border-edge bg-surface-2 px-3 text-sm text-ink focus:border-accent focus:outline-none"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@merchant.com"
            required
            className="h-10 rounded-lg border border-edge bg-surface-2 px-3 text-sm text-ink focus:border-accent focus:outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (min 8 chars)"
            required
            className="h-10 rounded-lg border border-edge bg-surface-2 px-3 text-sm text-ink focus:border-accent focus:outline-none"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="h-10 rounded-lg border border-edge bg-surface-2 px-3 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2 sm:col-span-2">
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent-strong"
            >
              Create user
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="inline-flex h-9 items-center rounded-lg border border-edge px-4 text-sm text-ink-2 transition hover:bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : users.length === 0 ? (
        <EmptyState title="No users yet" message="Add a user to grant dashboard access." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-edge bg-surface shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-left text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-4 py-3 font-semibold">User</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink">{u.name ?? u.email}</p>
                    <p className="text-xs text-ink-3">{u.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={ROLE_TONE[u.role] ?? 'neutral'}>{u.role.replace(/_/g, ' ')}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={u.status === 'active' ? 'success' : 'neutral'} dot>
                      {u.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {u.status === 'active' ? (
                      <button
                        onClick={() => updateStatus(u.id, 'deactivated')}
                        className="text-xs font-medium text-danger-ink hover:underline"
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        onClick={() => updateStatus(u.id, 'active')}
                        className="text-xs font-medium text-success-ink hover:underline"
                      >
                        Activate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
