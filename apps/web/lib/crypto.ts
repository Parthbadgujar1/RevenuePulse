// Re-export the shared AES-256-GCM secret encrypt/decrypt helpers so existing
// app call sites keep working. Implementation lives in @rp/observability so the
// queue worker decrypts the exact same secrets the web app writes.
export { encryptSecret, decryptSecret } from '@rp/observability';