import { redirect } from 'next/navigation';
import { hasPermission } from '@rp/auth';
import { requireMerchantContext } from '../../../lib/merchant-context';
import { PageHeader } from '../../../components/ui/states';
import { AdminUsersPanel } from '../../../components/admin-users-panel';
import { AuditLogViewer } from '../../../components/audit-log-viewer';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const ctx = await requireMerchantContext();
  const canViewAudit = hasPermission(ctx.role, 'audit:view');
  const canManageUsers = hasPermission(ctx.role, 'users:manage');

  // The administrative surface requires at least audit visibility. The
  // underlying APIs remain independently server-guarded per permission.
  if (!canViewAudit && !canManageUsers) {
    redirect('/dashboard');
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        title="Administration"
        subtitle="User access and the audit trail for this workspace. Every action here is permission-gated server-side."
      />

      {canManageUsers && <AdminUsersPanel />}
      {canViewAudit && <AuditLogViewer />}
    </div>
  );
}
