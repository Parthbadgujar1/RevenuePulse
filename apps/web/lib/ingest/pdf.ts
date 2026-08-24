/**
 * PDF text extraction + heuristic table reconstruction.
 * PDFs have no real table structure, so we look for lines that contain an
 * amount-like token plus a status keyword and (optionally) a date — the
 * common shape of exported payment reports / bank statements.
 */
import type { CsvTable } from './csv';

export async function parsePdf(buffer: Buffer): Promise<CsvTable> {
  // Dynamic import keeps pdf-parse out of the edge/client bundle graph.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return rowsFromText(result.text);
  } finally {
    await parser.destroy();
  }
}

export function rowsFromText(text: string): CsvTable {
  const headers = [
    'provider_txn_id',
    'amount',
    'status',
    'method',
    'error_code',
    'error_description',
    'created_at',
  ];
  const rows: Record<string, string>[] = [];

  const currencyPrefixRe =
    /(₹|rs\.?|inr)\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?)/gi;
  const plainNumberRe = /(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?/g;

  /** Extract the most plausible amount from a line. */
  function extractAmount(line: string): number | null {
    // 1. Currency-prefixed amounts win outright ("Rs. 1,499.00", "INR 500")
    let m: RegExpExecArray | null;
    currencyPrefixRe.lastIndex = 0;
    while ((m = currencyPrefixRe.exec(line))) {
      const val = parseFloat(m[2].replace(/,/g, ''));
      if (Number.isFinite(val)) return val;
    }
    // 2. Fall back to the largest standalone number that is not part of
    //    an identifier like pay_Ab12Cd34 (digit adjacent to a letter).
    plainNumberRe.lastIndex = 0;
    let best: number | null = null;
    while ((m = plainNumberRe.exec(line))) {
      const before = line[m.index - 1] ?? ' ';
      const after = line[m.index + m[0].length] ?? ' ';
      if (/[A-Za-z_-]/.test(before) || /[A-Za-z]/.test(after)) continue; // id fragment
      const val = parseFloat(m[0].replace(/,/g, ''));
      if (Number.isFinite(val) && (best === null || val > best)) best = val;
    }
    return best;
  }
  const statusKeywords: Array<[RegExp, string]> = [
    [/\bfail(?:ed|ure)?\b|\bdeclin(?:ed|e)\b|\bdenied\b/i, 'failed'],
    [/\breversed?\b|\brefund(ed)?\b/i, 'failed'],
    [/\bcaptured?\b|\bsuccess(?:ful)?\b|\bpaid\b|\bcompleted?\b/i, 'captured'],
    [/\bpending\b|\bprocessing\b|\binitiated\b|\bauthorized?\b/i, 'pending'],
  ];
  const idRe = /\b(?:pay|order|txn|tr(?:ansaction)?)[-_]?[A-Za-z0-9]{8,}\b/;
  const methodRe =
    /\b(upi|netbanking|net banking|card|debit card|credit card|wallet|emi)\b/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 10) continue;

    const idMatch = line.match(idRe);
    const methodMatch = line.match(methodRe);
    // A real payment row carries a transaction-id-like token or a payment
    // method — this rejects report headers like "Failed Payments Report".
    if (!idMatch && !methodMatch) continue;
    const amountNum = extractAmount(line);
    if (amountNum === null) continue;

    let status = '';
    for (const [re, s] of statusKeywords) {
      if (re.test(line)) {
        status = s;
        break;
      }
    }
    if (!status) continue;

    rows.push({
      provider_txn_id: idMatch ? idMatch[0] : `pdf_${rows.length + 1}`,
      amount: String(amountNum),
      status,
      method: methodMatch ? methodMatch[1].toLowerCase().replace(' ', '_') : '',
      error_code: '',
      error_description: line.length > 200 ? line.slice(0, 200) : line,
      created_at: '',
    });
  }

  return { headers, rows };
}
