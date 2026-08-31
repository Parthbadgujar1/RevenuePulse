import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '../components/theme-provider';
import { themeBootScript } from '../lib/theme-script';

export const metadata: Metadata = {
  title: 'RevenuePulse',
  description:
    'AI-powered revenue intelligence for digital merchants — detect problems, understand why they happen, and take action.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeBootScript() }}
        />
      </head>
      <body suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}