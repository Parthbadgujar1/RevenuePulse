import {
  Bell,
  CircleAlert,
  FlaskConical,
  Handshake,
  LayoutDashboard,
  LineChart,
  Plug,
  ReceiptIndianRupee,
  ReceiptText,
  RotateCcw,
  Settings2,
  ShoppingBag,
  FileUp,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  section?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Monitor',
    items: [
      { label: 'Revenue', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Transactions', href: '/transactions', icon: ReceiptText },
      { label: 'Failed Payments', href: '/cases', icon: CircleAlert },
      { label: 'Checkout', href: '/checkout', icon: ShoppingBag },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Receivables', href: '/receivables', icon: ReceiptIndianRupee },
      { label: 'Promises', href: '/promises', icon: Handshake },
      { label: 'Recovery Actions', href: '/actions', icon: RotateCcw },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { label: 'Analytics', href: '/analytics', icon: LineChart },
      { label: 'Demo Lab', href: '/demo-lab', icon: FlaskConical },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Import Data', href: '/ingest', icon: FileUp },
      { label: 'Integrations', href: '/integrations', icon: Plug },
      { label: 'Policies', href: '/settings', icon: Settings2 },
      { label: 'Notifications', href: '/notifications', icon: Bell },
      { label: 'Administration', href: '/admin', icon: ShieldCheck },
    ],
  },
];

export const FLAT_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ ...i, section: g.label })),
);

export function titleForPath(pathname: string): string {
  if (pathname === '/dashboard') return 'Revenue Command Center';
  if (pathname === '/transactions') return 'Transactions';
  if (pathname === '/cases') return 'Failed Payments';
  if (pathname === '/actions') return 'Recovery Actions';
  if (pathname === '/checkout') return 'Checkout Abandonment';
  if (pathname === '/receivables') return 'B2B Receivables';
  if (pathname === '/promises') return 'Promise-to-Pay';
  if (pathname === '/analytics') return 'Recovery Analytics';
  if (pathname === '/demo-lab') return 'Demo Lab';
  if (pathname === '/ingest') return 'Import Data';
  if (pathname === '/integrations') return 'Integrations';
  if (pathname === '/settings') return 'Policies & Guardrails';
  if (pathname === '/notifications') return 'Notifications';
  if (pathname === '/admin') return 'Administration';
  if (pathname.startsWith('/transactions/')) return 'Transaction Detail';
  if (pathname.startsWith('/cases/')) return 'Recovery Case';
  return 'RevenuePulse';
}

export function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}