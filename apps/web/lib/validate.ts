/**
 * Centralized request-body validation (zod).
 *
 * Usage inside a route handler:
 *   const parsed = await parseJsonBody(req, PolicySchema);
 *   if (!parsed.ok) return parsed.response;
 *   // parsed.data is fully typed
 */
import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

export async function parseJsonBody<T>(
  req: Request,
  schema: ZodType<T>
): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Request body must be valid JSON' },
        { status: 400 }
      ),
    };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Validation failed',
          issues: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        { status: 400 }
      ),
    };
  }
  return { ok: true, data: result.data };
}
