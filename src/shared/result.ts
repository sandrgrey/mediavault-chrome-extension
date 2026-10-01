export type MediaVaultErrorCode =
  | 'unsupported-page' | 'login-required' | 'media-not-found' | 'unavailable'
  | 'download-failed' | 'partial-carousel' | 'storage-failed' | 'extension-updated'
  | 'storage-empty-record' | 'invalid-message' | 'collection-incomplete'
  | 'collection-timeout' | 'too-many-items' | 'cancelled' | 'publication-changed'
  | 'identity-unavailable' | 'source-changed' | 'operation-expired' | 'needs-review' | 'busy';

export type Result<T> = { ok: true; value: T } | { ok: false; error: MediaVaultErrorCode };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(error: MediaVaultErrorCode): Result<T> => ({ ok: false, error });

const errorCodes: ReadonlySet<string> = new Set<MediaVaultErrorCode>([
  'unsupported-page', 'login-required', 'media-not-found', 'unavailable', 'download-failed',
  'partial-carousel', 'storage-failed', 'extension-updated', 'storage-empty-record', 'invalid-message',
  'collection-incomplete', 'collection-timeout', 'too-many-items', 'cancelled', 'publication-changed',
  'identity-unavailable', 'source-changed', 'operation-expired', 'needs-review', 'busy',
]);
export function isErrorCode(value: unknown): value is MediaVaultErrorCode {
  return typeof value === 'string' && errorCodes.has(value);
}
