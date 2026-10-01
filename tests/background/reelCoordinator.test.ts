import { afterEach, beforeEach, expect, it } from 'vitest';
import { openMediaVaultDatabase, type MediaVaultDatabase } from '../../src/storage/database';
import { createOperationRepository } from '../../src/storage/operations';
import { createReloadRepository } from '../../src/storage/reloadIntents';
import { createReelCoordinator } from '../../src/background/reelCoordinator';
import { createOperationQueue } from '../../src/background/operationQueue';
import { createRecovery } from '../../src/background/recovery';
import type { DownloadsPort } from '../../src/download/chromeDownloads';
let db: MediaVaultDatabase;
beforeEach(async () => { db = await openMediaVaultDatabase(crypto.randomUUID()); });
afterEach(() => db.close());
const old = { tabId: 1, documentId: 'old' }, owner = { tabId: 1, documentId: 'new' };
const identity = { publicationId: 'instagram:Ab', sourceIdentity: 'Ab', sourceUrl: 'https://www.instagram.com/reel/Ab/' };
const ready = (operationId: string) => ({ operationId, blobUrl: 'blob:https://www.instagram.com/12345678-abcd-1234-abcd-123456789abc', size: 100, mime: 'video/mp4' as const });
function setup(verifyContext = async () => true) {
  const operations = createOperationRepository(db), reloads = createReloadRepository(db), queue = createOperationQueue(), live = new Set<string>();
  let starts = 0, reloadCount = 0;
  const downloads: DownloadsPort = { start: async () => { starts++; return 7; }, get: async () => ({ id: 7, state: 'complete', filename: 'safe.mp4', errorCode: null }), onChange: () => () => {} };
  const recover = createRecovery(operations, downloads, () => 3000);
  const coordinator = createReelCoordinator({ operations, reloads, queue, live, downloads, recover, now: () => 2000,
    verifyContext, reloadTab: async () => { reloadCount++; }, cancelDownload: async () => {} });
  return { coordinator, operations, downloads, count: () => ({ starts, reloadCount }), recover };
}
it('reloads once, transfers document owner, completes one download and persists no blob URL', async () => {
  const f = setup();
  const begun = await f.coordinator.begin(old, identity, 'req', 'save');
  expect(begun.ok).toBe(true);
  expect(await f.coordinator.begin(old, identity, 'req', 'save')).toEqual(begun);
  expect(f.count()).toEqual({ starts: 0, reloadCount: 1 });
  const claimed = await f.coordinator.claim(owner, identity);
  if (!claimed.ok || !claimed.value) throw Error('claim');
  const id = claimed.value.operationId;
  expect((await f.coordinator.submit(old, identity, ready(id))).ok).toBe(false);
  expect(await f.coordinator.submit(owner, identity, ready(id))).toEqual({ ok: true, value: { state: 'completed', safeToRelease: true } });
  expect((await f.coordinator.submit(owner, identity, ready(id))).ok).toBe(true);
  expect(f.count().starts).toBe(1);
  expect(await db.count('publications')).toBe(1);
  expect(JSON.stringify(await db.getAll('operations'))).not.toMatch(/blob:|blobUrl/);
});
it('cancelled collection cannot start a download', async () => {
  const f = setup(); await f.coordinator.begin(old, identity, 'req', 'save');
  const claimed = await f.coordinator.claim(owner, identity);
  if (!claimed.ok || !claimed.value) throw Error('claim');
  const id = claimed.value.operationId;
  expect(await f.coordinator.cancel(owner, id)).toMatchObject({ ok: true, value: { state: 'cancelled' } });
  expect((await f.coordinator.submit(owner, identity, ready(id))).ok).toBe(false);
  expect(f.count().starts).toBe(0);
});
it('a restarted worker can accept the still-live claimed document without another reload', async () => {
  const first = setup(); await first.coordinator.begin(old, identity, 'req', 'save');
  const claimed = await first.coordinator.claim(owner, identity);
  if (!claimed.ok || !claimed.value) throw Error('claim');
  const restarted = setup();
  expect(await restarted.coordinator.submit(owner, identity, ready(claimed.value.operationId)))
    .toEqual({ ok: true, value: { state: 'completed', safeToRelease: true } });
  expect(restarted.count()).toEqual({ starts: 1, reloadCount: 0 });
});
it('rechecks the player immediately before dispatch and cancels without downloading', async () => {
  let checks = 0;
  const f = setup(async () => ++checks === 1);
  await f.coordinator.begin(old, identity, 'req', 'save');
  const claimed = await f.coordinator.claim(owner, identity);
  if (!claimed.ok || !claimed.value) throw Error('claim');
  const id = claimed.value.operationId;
  expect((await f.coordinator.submit(owner, identity, ready(id))).ok).toBe(false);
  expect(f.count().starts).toBe(0);
  expect((await f.coordinator.status(owner, id))).toMatchObject({ ok: true, value: { state: 'cancelled', safeToRelease: true } });
});
it('lost download ID is uncertain and repeating submit never dispatches again', async () => {
  const f = setup(); await f.coordinator.begin(old, identity, 'req', 'save');
  const claimed = await f.coordinator.claim(owner, identity);
  if (!claimed.ok || !claimed.value) throw Error('claim');
  const original = f.operations.transitionItem;
  f.operations.transitionItem = async (...args) => args[3] === 'downloading' ? { ok: false, error: 'storage-failed' } : original(...args);
  const id = claimed.value.operationId;
  await f.coordinator.submit(owner, identity, ready(id));
  await f.coordinator.submit(owner, identity, ready(id));
  expect(f.count().starts).toBe(1);
  expect((await f.operations.get(id))?.items[0].status).toBe('uncertain');
});
