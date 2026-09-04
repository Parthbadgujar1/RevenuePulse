import { NextResponse } from 'next/server';

/**
 * Unified API error contract (see Implementation Pack §6 / §12).
 *
 * Every error is serialized as:
 *   { success: false, error: { code, message, details } }
 * and success responses may use jsonSuccess() to carry `success: true`.
 */
export const API_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_CODES)[keyof typeof API_CODES];

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;
  details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static validation(message = 'Invalid request', details?: unknown): ApiError {
    return new ApiError(400, API_CODES.VALIDATION_ERROR, message, details);
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(401, API_CODES.AUTH_REQUIRED, message);
  }

  static forbidden(message = 'You do not have permission to do that'): ApiError {
    return new ApiError(403, API_CODES.FORBIDDEN, message);
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(404, API_CODES.NOT_FOUND, message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, API_CODES.CONFLICT, message);
  }

  static rateLimited(message = 'Too many requests'): ApiError {
    return new ApiError(429, API_CODES.RATE_LIMITED, message);
  }

  static internal(message = 'Internal error'): ApiError {
    return new ApiError(500, API_CODES.INTERNAL, message);
  }
}

export function errorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: {
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      },
    };
  }
  return {
    status: 500,
    body: {
      success: false,
      error: {
        code: API_CODES.INTERNAL,
        message: 'Internal error',
        details: {},
      },
    },
  };
}

export function jsonError(err: unknown): NextResponse {
  const { status, body } = errorBody(err);
  return NextResponse.json(body, { status });
}

export function jsonSuccess<T extends object>(data: T, init?: number | ResponseInit): NextResponse {
  const opts = typeof init === 'number' ? { status: init } : init;
  return NextResponse.json({ success: true, ...data } as T & { success: boolean }, opts);
}
