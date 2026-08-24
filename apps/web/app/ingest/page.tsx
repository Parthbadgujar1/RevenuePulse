import type { Metadata } from 'next';
import AppNav from '../../components/app-nav';
import IngestForm from '../../components/ingest-form';

export const metadata: Metadata = { title: 'Data Import · RevenuePulse' };

export default function IngestPage() {
  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900">Import real payment data</h1>
        <p className="mt-1 mb-8 max-w-2xl text-sm text-gray-500">
          Bring your own failed payments — a CSV export, an Excel workbook, or even a PDF
          report. RevenuePulse auto-detects the columns and runs every failure through the
          same AI recovery pipeline as live webhooks.
        </p>
        <IngestForm />
      </main>
    </>
  );
}
