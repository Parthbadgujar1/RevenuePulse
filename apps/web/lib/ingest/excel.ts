import { readSheet } from 'read-excel-file/node';
import type { CsvTable } from './csv';

function normalize(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

export async function parseExcel(buffer: Buffer): Promise<CsvTable> {
  const rows = await readSheet(buffer);
  if (rows.length === 0) return { headers: [], rows: [] };

  const rawHeaders = rows[0].map((h) => normalize(h));
  const headers = Array.from(new Set(rawHeaders.filter((h) => h && !/^(empty|__EMPTY)/i.test(h))));
  if (headers.length === 0) return { headers: [], rows: [] };

  const data = rows.slice(1).map((row) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < rawHeaders.length; i++) {
      const h = rawHeaders[i];
      if (h && headers.includes(h)) out[h] = normalize(row[i]);
    }
    return out;
  });

  return {
    headers,
    rows: data.filter((r) => Object.values(r).some((v) => v.length > 0)),
  };
}
