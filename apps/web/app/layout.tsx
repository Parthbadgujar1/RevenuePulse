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
      <body>{children}</body>
    </html>
  );
}
