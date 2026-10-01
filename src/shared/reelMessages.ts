import type { SaveMode, Owner } from '../domain/models';
import { reelIdentity, type ReelIdentity } from '../providers/instagram/reelIdentity';
import { plain, shortString } from '../media/reelProtocol';
import { fail, ok, type Result } from './result';
export type ReadyBlob = { operationId: string; blobUrl: string; size: number; mime: 'video/mp4' };
export type ReelMessage = { version: 1; type: 'reel-begin'; requestId: string; mode: SaveMode } |
  { version: 1; type: 'reel-claim' } | { version: 1; type: 'reel-submit'; result: ReadyBlob } |
  { version: 1; type: 'reel-cancel' | 'reel-status'; operationId: string };
export function parseReelMessage(input: unknown): ReelMessage | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (value.version !== 1) return null;
  if (plain(value, ['version', 'type']) && value.type === 'reel-claim') return value as ReelMessage;
  if (plain(value, ['version', 'type', 'requestId', 'mode']) && value.type === 'reel-begin' &&
    shortString(value.requestId) && value.requestId.length <= 128 && ['save', 'retry', 'redownload'].includes(String(value.mode))) return value as ReelMessage;
  if (plain(value, ['version', 'type', 'operationId']) && ['reel-status', 'reel-cancel'].includes(String(value.type)) && shortString(value.operationId)) return value as ReelMessage;
  if (plain(value, ['version', 'type', 'result']) && value.type === 'reel-submit') {
    const r = value.result;
    if (plain(r, ['operationId', 'blobUrl', 'size', 'mime']) && shortString(r.operationId) &&
      typeof r.blobUrl === 'string' && /^blob:https:\/\/www\.instagram\.com\/[a-f0-9-]{36}$/.test(r.blobUrl) &&
      typeof r.size === 'number' && Number.isSafeInteger(r.size) && r.size > 0 && r.size <= 80 * 1024 * 1024 && r.mime === 'video/mp4') return value as ReelMessage;
  }
  return null;
}
export function senderOwner(sender: chrome.runtime.MessageSender, currentUrl: string, extensionId: string): Result<{ owner: Owner; identity: ReelIdentity }> {
  const tabId = sender.tab?.id;
  if (sender.id !== extensionId || sender.frameId !== 0 || typeof tabId !== 'number' || !Number.isInteger(tabId) ||
    tabId < 0 || !shortString(sender.documentId) || !sender.url) return fail('invalid-message');
  const from = reelIdentity(sender.url), current = reelIdentity(currentUrl);
  if (!from.ok || !current.ok || from.value.publicationId !== current.value.publicationId) return fail('publication-changed');
  return ok({ owner: { tabId, documentId: sender.documentId }, identity: current.value });
}
