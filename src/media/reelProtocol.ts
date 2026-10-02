import type { ReelSession } from '../storage/reloadIntents';
export type TrackPair = { videoUrl: string; audioUrl: string | null };
export type BridgeMessage = { version: 1; type: 'activate'; session: ReelSession } | { version: 1; type: 'cancel'; operationId: string };
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const MAX_TRACK_BYTES = 64 * 1024 * 1024;
const hosts = new Set(['scontent-lax7-1.cdninstagram.com', 'scontent-lax3-1.cdninstagram.com', 'scontent-lax3-2.cdninstagram.com']);
export function mediaUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password || !url.pathname.endsWith('.mp4')) return null;
    url.searchParams.delete('bytestart'); url.searchParams.delete('byteend'); url.hash = '';
    return url;
  } catch { return null; }
}
export function plain(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Object.keys(value);
  return own.length === keys.length && own.every(key => keys.includes(key));
}
export const shortString = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
export function parseBridgeMessage(value: unknown): BridgeMessage | null {
  if (plain(value, ['version', 'type', 'operationId']) && value.version === 1 && value.type === 'cancel' && shortString(value.operationId)) return value as BridgeMessage;
  if (!plain(value, ['version', 'type', 'session']) || value.version !== 1 || value.type !== 'activate') return null;
  const s = value.session;
  if (!plain(s, ['operationId', 'token', 'deadlineMs']) || !shortString(s.operationId) || !shortString(s.token) || typeof s.deadlineMs !== 'number' || !Number.isFinite(s.deadlineMs)) return null;
  return value as BridgeMessage;
}
