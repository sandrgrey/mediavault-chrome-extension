import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMediaVaultDatabase, type MediaVaultDatabase } from '../../src/storage/database';
import { createOperationRepository } from '../../src/storage/operations';
import type { BeginInput } from '../../src/domain/models';
import { metadata, previous, resolved } from '../helpers/domain';

let db: MediaVaultDatabase;
const owner = { tabId: 1, documentId: 'document-1' };
const beginInput = (requestId = 'request-1'): BeginInput => ({ requestId, publicationId: metadata.id, owner, mode: 'save', nowMs: 1000 });
beforeEach(async () => { db = await openMediaVaultDatabase(`test-${crypto.randomUUID()}`); });
afterEach(() => { db.close(); });

async function beginAndAttach() {
  const repository = createOperationRepository(db);
  const started = await repository.begin(beginInput());
  if (!started.ok || started.value.kind !== 'accepted') throw Error('begin failed');
  const id = started.value.operationId;
  const attached = await repository.attachCollection({ operationId: id, publication: resolved(), owner }, 2000);
  expect(attached).toEqual({ ok: true, value: undefined });
  return { repository, id };
}

describe('atomic operation journal', () => {
  it('reserves one operation for two simultaneous tabs', async () => {
    const repo = createOperationRepository(db);
    const results = await Promise.all([repo.begin(beginInput()), repo.begin({ ...beginInput('request-2'), owner: { ...owner, tabId: 2 } })]);
    expect(results.map(x => x.ok && x.value.kind).sort()).toEqual(['accepted', 'busy']);
    expect(await db.count('operations')).toBe(1);
  });
  it('returns the same operation for a repeated request without creating duplicates', async () => {
    const repo = createOperationRepository(db);
    expect(await repo.begin(beginInput())).toEqual(await repo.begin(beginInput()));
    expect(await db.count('operations')).toBe(1);
  });
  it('rejects reuse of a request by a different document', async () => {
    const repo = createOperationRepository(db); await repo.begin(beginInput());
    expect(await repo.begin({ ...beginInput(), owner: { ...owner, documentId: 'different' } }))
      .toEqual({ ok: false, error: 'invalid-message' });
  });
  it('prevents a fresh save for completed or partial history', async () => {
    const repo = createOperationRepository(db); const old = previous();
    await db.put('publications', old);
    expect(await repo.begin(beginInput())).toEqual({ ok: true, value: { kind: 'retry-required' } });
    old.items[1].status = 'completed'; old.items[1].errorCode = null;
    await db.put('publications', old);
    expect(await repo.begin(beginInput())).toEqual({ ok: true, value: { kind: 'already-saved' } });
    expect(await db.count('operations')).toBe(0);
  });
  it('persists only safe metadata and never writes a library record on submission', async () => {
    const { repository, id } = await beginAndAttach();
    const stored = await repository.get(id);
    expect(stored?.items.map(x => x.status)).toEqual(['pending', 'pending', 'pending']);
    expect(JSON.stringify(stored)).not.toMatch(/downloadUrl|fixture\.invalid|SYNTHETIC_ONLY/);
    expect(await db.count('publications')).toBe(0);
  });
  it('rejects a mismatched owner and an expired collection', async () => {
    const repo = createOperationRepository(db); const begun = await repo.begin(beginInput());
    if (!begun.ok || begun.value.kind !== 'accepted') throw Error('begin');
    const operationId = begun.value.operationId;
    expect(await repo.attachCollection({ operationId, publication: resolved(), owner: { ...owner, tabId: 2 } }, 2000))
      .toEqual({ ok: false, error: 'invalid-message' });
    expect(await repo.attachCollection({ operationId, publication: resolved(), owner }, 151_001))
      .toEqual({ ok: false, error: 'operation-expired' });
    expect(await db.count('publications')).toBe(0);
  });
  it('writes the library only on completion and rejects an out-of-order transition', async () => {
    const { repository, id } = await beginAndAttach();
    expect(await repository.transitionItem(id, 0, 'pending', 'completed', { downloadId: 8 }))
      .toEqual({ ok: false, error: 'invalid-message' });
    await repository.transitionItem(id, 0, 'pending', 'dispatching', {});
    await repository.transitionItem(id, 0, 'dispatching', 'downloading', { downloadId: 8 });
    expect(await db.count('publications')).toBe(0);
    await repository.transitionItem(id, 0, 'downloading', 'completed', {});
    expect((await db.get('publications', metadata.id))?.items[0]).toMatchObject({ status: 'completed', downloadId: 8 });
    expect((await repository.get(id))?.items[0].status).toBe('completed');
  });
  it('does not manufacture a library record after total failure', async () => {
    const { repository, id } = await beginAndAttach();
    for (const i of [0, 1, 2]) {
      await repository.transitionItem(id, i, 'pending', 'dispatching', {});
      await repository.transitionItem(id, i, 'dispatching', 'failed', { errorCode: 'download-failed' });
    }
    await repository.settle(id, 'failed', '2026-01-02T00:00:00.000Z');
    expect(await db.count('publications')).toBe(0);
    expect(await db.count('activePublications')).toBe(0);
  });
  it('records cancellation and prevents dispatching new items', async () => {
    const { repository, id } = await beginAndAttach();
    await repository.requestCancel(id);
    expect((await repository.get(id))?.cancelRequested).toBe(true);
    expect(await repository.transitionItem(id, 0, 'pending', 'dispatching', {})).toEqual({ ok: false, error: 'cancelled' });
  });
  it('does not release a newer reservation when cancellation of an old attempt arrives late', async () => {
    const { repository, id } = await beginAndAttach();
    await repository.requestCancel(id);
    const terminal = await repository.get(id);
    const restarted = await repository.begin(beginInput('request-2'));
    expect(restarted).toMatchObject({ ok: true, value: { kind: 'accepted' } });
    await repository.requestCancel(id);
    expect(await repository.get(id)).toEqual(terminal);
    expect(await repository.begin({ ...beginInput('request-3'), owner: { ...owner, tabId: 2 } }))
      .toEqual({ ok: true, value: { kind: 'busy' } });
  });
  it('atomically rolls back a failed write without changing the prior library', async () => {
    const old = previous(); await db.put('publications', old);
    const repository = createOperationRepository(db);
    const started = await repository.begin({ ...beginInput(), mode: 'retry' });
    if (!started.ok || started.value.kind !== 'accepted') throw Error('begin failed');
    const id = started.value.operationId;
    await repository.attachCollection({ operationId: id, publication: resolved(), owner }, 2000);
    await repository.transitionItem(id, 1, 'pending', 'dispatching', {});
    await repository.transitionItem(id, 1, 'dispatching', 'downloading', { downloadId: 99 });
    const before = await repository.get(id);
    const priorLibrary = await db.get('publications', old.id);
    const put = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'publications') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return put.call(this, value, key);
    });
    expect(await repository.transitionItem(id, 1, 'downloading', 'completed', {}))
      .toEqual({ ok: false, error: 'storage-failed' });
    fault.mockRestore();
    expect(await repository.get(id)).toEqual(before);
    expect(await db.get('publications', old.id)).toEqual(priorLibrary);
    expect((await db.get('publications', old.id))?.items.filter(item => item.status === 'completed'))
      .toEqual(old.items.filter(item => item.status === 'completed'));
    expect(await repository.transitionItem(id, 1, 'downloading', 'completed', {})).toEqual({ ok: true, value: undefined });
    expect((await db.get('publications', old.id))?.items[1]).toMatchObject({ status: 'completed', downloadId: 99 });
  });
  it('rejects an invalid expected count without changing the collecting operation', async () => {
    const repository = createOperationRepository(db);
    const started = await repository.begin(beginInput());
    if (!started.ok || started.value.kind !== 'accepted') throw Error('begin failed');
    const id = started.value.operationId, before = await repository.get(id);
    expect(await repository.attachCollection({ operationId: id, publication: { ...resolved(), expectedCount: 2 }, owner }, 2000))
      .toEqual({ ok: false, error: 'invalid-message' });
    expect(await repository.get(id)).toEqual(before);
    expect(await db.count('publications')).toBe(0);
  });
  it('does not reset a started download when a collection is submitted twice', async () => {
    const { repository, id } = await beginAndAttach();
    await repository.transitionItem(id, 0, 'pending', 'dispatching', {});
    await repository.transitionItem(id, 0, 'dispatching', 'downloading', { downloadId: 99 });
    const before = await repository.get(id);
    expect(await repository.attachCollection({ operationId: id, publication: resolved(), owner }, 3000))
      .toEqual({ ok: false, error: 'invalid-message' });
    expect(await repository.get(id)).toEqual(before);
  });
  it('supersedes an uncertain attempt only on explicit redownload and rejects its late result', async () => {
    const { repository, id } = await beginAndAttach();
    await repository.transitionItem(id, 0, 'pending', 'dispatching', {});
    await repository.transitionItem(id, 0, 'dispatching', 'uncertain', { errorCode: 'needs-review' });
    await repository.settle(id, 'uncertain', '2026-01-02T00:00:00.000Z');
    const restarted = await repository.begin({ ...beginInput('request-2'), mode: 'redownload' });
    expect(restarted).toMatchObject({ ok: true, value: { kind: 'accepted' } });
    expect((await repository.get(id))?.superseded).toBe(true);
    expect(await repository.transitionItem(id, 0, 'uncertain', 'completed', { downloadId: 99 }))
      .toEqual({ ok: false, error: 'invalid-message' });
    expect(await db.count('publications')).toBe(0);
    expect((await repository.findRecoverable()).map(op => op.requestId)).toEqual(['request-2']);
  });
  it('returns a storage error if the database is closed before a write begins', async () => {
    const repository = createOperationRepository(db);
    db.close();
    expect(await repository.begin(beginInput())).toEqual({ ok: false, error: 'storage-failed' });
  });
  it('can read a pending operation after closing and reopening the database', async () => {
    const { id } = await beginAndAttach(); const name = db.name; db.close();
    db = await openMediaVaultDatabase(name);
    expect((await createOperationRepository(db).get(id))?.state).toBe('downloading');
  });
  it('does not allow uncertain operations to be silently restarted', async () => {
    const { repository, id } = await beginAndAttach();
    await repository.transitionItem(id, 0, 'pending', 'dispatching', {});
    await repository.transitionItem(id, 0, 'dispatching', 'uncertain', { errorCode: 'needs-review' });
    await repository.settle(id, 'uncertain', '2026-01-02T00:00:00.000Z');
    expect(await repository.begin(beginInput('request-2'))).toEqual({ ok: true, value: { kind: 'needs-review' } });
  });
});
