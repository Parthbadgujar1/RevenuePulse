import { getServerSession } from 'next-auth';
import { authOptions } from '@rp/auth';
import { ToastProvider } from '../../components/ui/toast';
import { AppShell } from '../../components/shell/app-shell';

export default async function ShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  const user = (session?.user ?? {}) as {
    name?: string | null;
    email?: string | null;
    role?: string;
  };
  return (
    <ToastProvider>
      <AppShell user={user}>{children}</AppShell>
    </ToastProvider>
  );
}