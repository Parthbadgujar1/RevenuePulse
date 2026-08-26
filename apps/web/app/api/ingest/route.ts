import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@rp/database';
import { processJob, JobType } from '@rp/observability';
import { normalizeRazorpayEvent } from '@rp/razorpay';
import { parseCsv } from '../../../lib/ingest/csv';
import { parseExcel } from '../../../lib/ingest/excel';
import { parsePdf } from '../../../lib/ingest/pdf';
import {
  autoMapHeaders,
  convertRow,
  previewCategory,
  type AmountUnit,
} from '../../../lib/ingest/map';
import { requireMerchantContext } from '../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../lib/rate-limit';
import { csrfGuard } from '../../../lib/csrf';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;

function tableFromBuffer(name: string, buf: Buffer): Promise<ReturnType<typeof parseCsv>> {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return Promise.resolve(parseCsv(buf.toString('utf8')));
  if (ext === 'xlsx' || ext === 'xls') return Promise.resolve(parseExcel(buf));
  if (ext === 'pdf') return parsePdf(buf);
  return Promise.reject(new Error(`Unsupported file type ".${ext}" — use CSV, XLSX or PDF`));
}

function normalizedId(raw: Record<string, unknown>): string {
  const d = raw.data as Record<string, unknown> | undefined;
  const id = String(d?.id ?? '');
  return id || crypto.createHash('sha1').update(JSON.stringify(raw)).digest('hex').slice(0, 12);
}

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data with a "file" field' }, { status: 400 });
  }

  const file = form.get('file') as File | null;
  if (!file || file.size === 0) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File too large (max 10 MB)' }, { status: 400 });
  }

  const dryRun = String(form.get('dryRun') ?? 'true') !== 'false';
  const amountUnit = (String(form.get('amountUnit') ?? 'auto') as AmountUnit) || 'auto';

  // Stable file fingerprint for idempotent re-imports
  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex').slice(0, 16);

  let table;
  try {
    table = await tableFromBuffer(file.name, fileBuffer);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Could not parse file' }, { status: 400 });
  }

  if (!table.headers.length || !table.rows.length) {
    return NextResponse.json(
      { error: 'No tabular rows found in the document. For PDFs we need lines containing an amount and a status keyword.' },
      { status: 400 },
    );
  }
  if (table.rows.length > MAX_ROWS) {
    table.rows = table.rows.slice(0, MAX_ROWS);
  }

  const { mapping, details, unmappedHeaders } = autoMapHeaders(table.headers);

  if (!mapping.amount) {
    return NextResponse.json(
      {
        error: 'Could not detect an amount column. Rename a column to something like "amount" / "value" and retry.',
        detectedHeaders: table.headers,
      },
      { status: 422 },
    );
  }

  // Convert every row; keep skip reasons for transparency
  const rawEvents: Record<string, unknown>[] = [];
  const skipped: Record<string, number> = {};
  for (let i = 0; i < table.rows.length; i++) {
    const conv = convertRow(table.rows[i], mapping, { amountUnit }, i);
    if (!conv.rawEvent) {
      const reason = conv.reason ?? 'unknown';
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    rawEvents.push(conv.rawEvent);
  }

  // Preview stats
  const failed = rawEvents.filter((e) => e.event === 'payment_failed');
  const categoryCounts: Record<string, number> = {};
  const sampleAmountsPaise: number[] = [];
  for (const e of failed.slice(0, 500)) {
    const d = e.data as any;
    const cat = previewCategory(d.error?.description ?? '', d.error?.code ?? '');
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
    if (sampleAmountsPaise.length < 200) sampleAmountsPaise.push(d.amount);
  }
  const atRiskPaise = rawEvents
    .filter((e) => e.event === 'payment_failed')
    .reduce((s, e) => s + ((e.data as any).amount ?? 0), 0);

  const preview = {
    fileName: file.name,
    fileType: file.name.toLowerCase().split('.').pop(),
    headers: table.headers,
    mapping: details,
    unmappedHeaders,
    totalRows: table.rows.length,
    failureCount: failed.length,
    capturedCount: rawEvents.filter((e) => e.event === 'payment_captured').length,
    skipped,
    estimatedAtRiskInr: atRiskPaise / 100,
    categoryCounts,
    sampleRows: rawEvents.slice(0, 3).map((e) => ({
      event: e.event,
      ...(e.data as object),
    })),
  };

  if (dryRun) {
    return NextResponse.json({ ...preview, ingested: false });
  }

  // ---- Commit: run through the real pipeline ----
  if (failed.length === 0) {
    return NextResponse.json({ ...preview, ingested: true, note: 'No failed payments found — nothing to recover.' });
  }

  const { merchantId } = await requireMerchantContext();
  const rl = checkRateLimit(req, 'ingest', { limit: 20, windowMs: 60_000 }, merchantId);
  if (!rl.allowed) return rateLimitResponse(rl);
  const cohortStart = new Date();
  let processed = 0;
  let pipelineErrors = 0;
  let duplicatesSkipped = 0;

  for (let rowIdx = 0; rowIdx < rawEvents.length; rowIdx++) {
    const raw = rawEvents[rowIdx];
    // Stable idempotency key: same file + same payment id never re-ingests.
    const providerEventId = `upload:${fileHash}:${normalizedId(raw)}`;
    const existing = await prisma.webhookEvent.findUnique({ where: { providerEventId } });
    if (existing) {
      duplicatesSkipped++;
      continue;
    }
    const normalized = normalizeRazorpayEvent(raw as any);
    const webhookRow = await prisma.webhookEvent.create({
      data: {
        providerEventId,
        eventType: normalized.eventType,
        payloadHash: `sha:${normalized.safeMetadata.providerTransactionId}`,
        status: 'RECEIVED',
        merchantId,
      },
    });
    const result = await processJob({} as any, JobType.PROCESS_TRANSACTION_EVENT, {
      event: normalized,
      eventRef: webhookRow.id,
      webhookEventId: webhookRow.id,
      source: 'upload',
      simulated: true,
    });
    if (result.success) processed++;
    else pipelineErrors++;
  }

  const cohortCases = await prisma.revenueCase.findMany({
    where: { merchantId, createdAt: { gte: cohortStart } },
    select: { id: true },
  });
  const [casesCreated, actionsCreated] = await Promise.all([
    cohortCases.length,
    prisma.recoveryAction.count({
      where: { caseId: { in: cohortCases.map((c) => c.id) }, createdAt: { gte: cohortStart } },
    }),
  ]);

  return NextResponse.json({
    ...preview,
    ingested: true,
    processed,
    duplicatesSkipped,
    pipelineErrors,
    casesCreated,
    actionsCreated,
    cohortStart: cohortStart.toISOString(),
  });
}
