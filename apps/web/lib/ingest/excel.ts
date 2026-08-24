import * as XLSX from 'xlsx';
import type { CsvTable } from './csv';

export function parseExcel(buffer: Buffer): CsvTable {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = wb.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: true,
  });
  if (json.length === 0) return { headers: [], rows: [] };

  const headerSet = new Set<string>();
  for (const row of json) {
    for (const k of Object.keys(row)) {
      const h = String(k).trim();
      if (h && !/^(empty|__EMPTY)/i.test(h)) headerSet.add(h);
    }
  }
  const headers = Array.from(headerSet);
  const rows = json
    .map((row) => {
      const out: Record<string, string> = {};
      for (const h of headers) {
        const v = row[h];
        out[h] = v instanceof Date ? v.toISOString() : String(v ?? '').trim();
      }
      return out;
    })
    .filter((r) => Object.values(r).some((v) => v.length > 0));
  return { headers, rows };
}
