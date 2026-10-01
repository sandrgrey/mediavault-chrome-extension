import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDB } from 'idb';
import { openMediaVaultDatabase, type MediaVaultDatabase } from '../../src/storage/database';
import { createOperationRepository } from '../../src/storage/operations';
import { createReloadRepository } from '../../src/storage/reloadIntents';
import { operation, previous } from '../helpers/domain';
let db: MediaVaultDatabase;
const owner = { tabId: 1, documentId: 'old' }, next = { tabId: 1, documentId: 'new' };
let id: string;
beforeEach(async () => {
  db = await openMediaVaultDatabase(`reload-${crypto.randomUUID()}`);
  const result = await createOperationRepository(db).begin({ owner, requestId: 'request', publicationId: 'instagram:Ab', mode: 'save', nowMs: 1000 });
  if (!result.ok || result.value.kind !== 'accepted') throw Error('begin');
  id = result.value.operationId;
});
afterEach(() => db.close());
async function prepared() {
  const repo = createReloadRepository(db);
  const result = await repo.prepare(id, owner, 'instagram:Ab', 2000);
  expect(result.ok).toBe(true);
  return repo;
}
it('preserves old stores and records during schema 1 upgrade', async () => {
  const name = `migration-${crypto.randomUUID()}`;
  const old = await openDB(name, 1, { upgrade(db) {
    const publications = db.createObjectStore('publications', { keyPath: 'id' }); publications.createIndex('sourceIdentity', 'sourceIdentity'); publications.createIndex('savedAt', 'savedAt');
    const operations = db.createObjectStore('operations', { keyPath: 'id' }); operations.createIndex('requestId', 'requestId', { unique: true }); operations.createIndex('publicationId', 'publicationId'); operations.createIndex('state', 'state');
    db.createObjectStore('activePublications', { keyPath: 'publicationId' });
    db.createObjectStore('sourceIntents', { keyPath: 'tabId' }).createIndex('publicationId', 'publicationId');
  } });
  await old.put('operations', operation()); await old.put('publications', previous()); old.close();
  const upgraded = await openMediaVaultDatabase(name);
  try {
    expect(await upgraded.get('operations', 'operation-1')).toEqual(operation());
    expect(await upgraded.get('publications', previous().id)).toEqual(previous());
    expect(Array.from(upgraded.objectStoreNames)).toContain('reloadIntents');
  } finally { upgraded.close(); }
});
it('issues once and atomically transfers only to one new document', async () => {
  const repo = await prepared();
  expect(await repo.claim(next, 'instagram:Ab', 2500)).toEqual({ ok: false, error: 'invalid-message' });
  expect(await repo.markIssued(id)).toEqual({ ok: true, value: true });
  expect(await repo.markIssued(id)).toEqual({ ok: true, value: false });
  expect(await repo.claim(owner, 'instagram:Ab', 3000)).toEqual({ ok: false, error: 'invalid-message' });
  const claimed = await repo.claim(next, 'instagram:Ab', 3000);
  expect(claimed).toMatchObject({ ok: true, value: { operationId: id, deadlineMs: 151000 } });
  expect(await repo.claim(next, 'instagram:Ab', 4000)).toEqual(claimed);
  expect((await db.get('operations', id))?.owner).toEqual(next);
  expect(await repo.claim({ ...next, documentId: 'third' }, 'instagram:Ab', 4000)).toEqual({ ok: false, error: 'invalid-message' });
});
it('preparation retry preserves its token and expiration', async () => {
  const repo = await prepared();
  const first = await repo.prepare(id, owner, 'instagram:Ab', 2000);
  expect(await repo.prepare(id, owner, 'instagram:Ab', 4000)).toEqual(first);
});
it('rejects wrong publication, expired and cancelled operations', async () => {
  const repo = await prepared(); await repo.markIssued(id);
  expect(await repo.claim(next, 'instagram:Other', 3000)).toEqual({ ok: false, error: 'invalid-message' });
  expect(await repo.claim({ ...next, tabId: 2 }, 'instagram:Ab', 3000)).toEqual({ ok: true, value: null });
  expect(await repo.claim(next, 'instagram:Ab', 151001)).toEqual({ ok: false, error: 'operation-expired' });
  await createOperationRepository(db).requestCancel(id);
  expect(await repo.claim(next, 'instagram:Ab', 4000)).toEqual({ ok: false, error: 'cancelled' });
  expect((await db.get('operations', id))?.owner).toEqual(owner);
});
it('does not let a forged prepare transfer another owners operation', async () => {
  const repo = createReloadRepository(db);
  expect(await repo.prepare(id, next, 'instagram:Ab', 2000)).toEqual({ ok: false, error: 'invalid-message' });
  expect(await repo.prepare(id, owner, 'instagram:Other', 2000)).toEqual({ ok: false, error: 'invalid-message' });
});
it('allows only one of concurrent new documents to claim', async () => {
  const repo = await prepared(); await repo.markIssued(id);
  const results = await Promise.all([repo.claim(next, 'instagram:Ab', 3000), repo.claim({ ...next, documentId: 'racer' }, 'instagram:Ab', 3000)]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
});
it('removes only the named intent and fails safely if storage closed', async () => {
  const repo = await prepared();
  expect(await repo.remove('unknown')).toEqual({ ok: true, value: undefined });
  await repo.markIssued(id);
  expect((await repo.claim(next, 'instagram:Ab', 3000)).ok).toBe(true);
  expect(await repo.remove(id)).toEqual({ ok: true, value: undefined });
  expect(await repo.claim(next, 'instagram:Ab', 3001)).toEqual({ ok: true, value: null });
  db.close();
  expect(await repo.claim(next, 'instagram:Ab', 3002)).toEqual({ ok: false, error: 'storage-failed' });
});

