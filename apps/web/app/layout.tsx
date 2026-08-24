import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RevenuePulse',
  description: 'AI-powered revenue recovery for digital merchants',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: browser extensions (e.g. Grammarly) inject
          attributes like data-gr-ext-installed onto <body> before hydration */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
