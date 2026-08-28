'use client';

const CSRF_COOKIE = 'rp_csrf';
const CSRF_HEADER = 'x-rp-csrf';

/**
 * Client-side helper for the double-submit CSRF cookie pattern.
 *
 * The server issues an `rp_csrf` cookie (readable by JS, not HttpOnly) and
 * mutating routes reject requests carrying a session cookie unless the
 * `x-rp-csrf` request header matches that cookie. This helper reads the
 * cookie and attaches the header to browser-initiated mutations so they
 * don't get 403s.
 *
 * Requests without a session cookie (server-to-server, webhooks) are not
 * CSRF-checked server-side, so the header is harmless to always send.
 */

function readCsrfCookie(): string {
  const cookie = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`));
  if (!cookie) return '';
  return decodeURIComponent(cookie.slice(CSRF_COOKIE.length + 1));
}

function isMutating(method?: string): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

export function csrfHeaders(init?: RequestInit): HeadersInit {
  if (!isMutating(init?.method)) return init?.headers ?? {};
  const headers = new Headers(init?.headers);
  const token = readCsrfCookie();
  if (token) headers.set(CSRF_HEADER, token);
  return headers;
}

export async function csrfFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, headers: csrfHeaders(init) });
}