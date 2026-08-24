/**
 * Minimal robust CSV parser: delimiter sniffing, quoted fields, CRLF, BOM.
 * No external dependency.
 */
export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): CsvTable {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const firstLine = clean.split('\n', 1)[0] ?? '';
  const candidates = [',', ';', '\t', '|'];
  let delimiter = ',';
  let best = 0;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > best) {
      best = count;
      delimiter = d;
    }
  }

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  // Drop blank trailing rows
  const nonEmpty = records.filter((r) => r.some((c) => c.trim().length > 0));
  if (nonEmpty.length < 2) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h) row[h] = (cells[idx] ?? '').trim();
    });
    return row;
  });
  return { headers, rows };
}
