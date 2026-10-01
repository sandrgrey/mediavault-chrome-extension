import { expect, it } from 'vitest';
import { parseReelMessage, senderOwner } from '../../src/shared/reelMessages';
const result = { operationId: 'op', blobUrl: 'blob:https://www.instagram.com/12345678-abcd-1234-abcd-123456789abc', size: 100, mime: 'video/mp4' };
it('accepts only bounded result and supported commands, never arbitrary HTTP downloads or extra authority', () => {
  expect(parseReelMessage({ version: 1, type: 'reel-submit', result })).not.toBeNull();
  expect(parseReelMessage({ version: 1, type: 'reel-begin', requestId: 'req', mode: 'save' })).not.toBeNull();
  for (const changed of [{ ...result, blobUrl: 'https://www.instagram.com/x' }, { ...result, size: 90 * 1024 * 1024 },
    { ...result, blobUrl: 'blob:https://evil.example/id' }, { ...result, size: -1 }, { ...result, cookie: 'secret' }])
    expect(parseReelMessage({ version: 1, type: 'reel-submit', result: changed })).toBeNull();
  expect(parseReelMessage({ version: 1, type: 'reel-claim', owner: { tabId: 1 } })).toBeNull();
});
it('derives owner only from extension sender in the current top-frame route', () => {
  const sender = { id: 'extension', tab: { id: 1 }, frameId: 0, documentId: 'doc', url: 'https://www.instagram.com/reel/Ab/' } as chrome.runtime.MessageSender;
  expect(senderOwner(sender, sender.url!, 'extension')).toMatchObject({ ok: true, value: { owner: { tabId: 1, documentId: 'doc' } } });
  expect(senderOwner(sender, 'https://www.instagram.com/reel/Other/', 'extension').ok).toBe(false);
  for (const changed of [{ ...sender, id: 'other' }, { ...sender, frameId: 1 }, { ...sender, documentId: undefined }, { ...sender, tab: undefined }])
    expect(senderOwner(changed, sender.url!, 'extension').ok).toBe(false);
});

