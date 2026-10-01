import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMediaVaultDatabase, type MediaVaultDatabase } from '../../src/storage/database';
import { createLibraryRepository } from '../../src/library/repository';
import { createOperationRepository } from '../../src/storage/operations';
import { operation, previous } from '../helpers/domain';

let db: MediaVaultDatabase;
beforeEach(async () => { db = await openMediaVaultDatabase(`library-test-${crypto.randomUUID()}`); });
afterEach(() => { db.close(); });
describe('local library repository', () => {
  it('lists newest first and reads by identity', async () => {
    const repo = createLibraryRepository(db); const a = previous();
    const b = { ...previous(), id: 'instagram:NEW', sourceIdentity: 'NEW', savedAt: '2026-02-01T00:00:00.000Z' };
    await db.put('publications', a); await db.put('publications', b);
    expect((await repo.list()).map(x => x.id)).toEqual(['instagram:NEW', 'instagram:ABC123']);
    expect(await repo.get(a.id)).toEqual(a);
  });
  it('removes history and terminal journals without touching downloaded files', async () => {
    const repo = createLibraryRepository(db); const old = previous(); const op = operation(); op.state = 'partial';
    await db.put('publications', old); await db.put('operations', op);
    await db.put('sourceIntents', { tabId: 3, publicationId: old.id, mode: 'retry', expiresAtMs: 1000 });
    expect(await repo.remove(old.id)).toEqual({ ok: true, value: undefined });
    expect(await repo.get(old.id)).toBeNull();
    expect(await db.count('operations')).toBe(0);
    expect(await db.count('sourceIntents')).toBe(0);
    expect(await createOperationRepository(db).transitionItem(op.id, 1, 'downloading', 'completed', { downloadId: 99 }))
      .toEqual({ ok: false, error: 'invalid-message' });
    expect(await repo.get(old.id)).toBeNull();
  });
  it('does not remove history while its download operation remains active', async () => {
    const repo = createLibraryRepository(db); const old = previous(); await db.put('publications', old);
    await db.put('activePublications', { publicationId: old.id, operationId: 'active-1' });
    expect(await repo.remove(old.id)).toEqual({ ok: false, error: 'busy' });
    expect(await repo.get(old.id)).toEqual(old);
  });
  it('returns a storage error when deleting history after the database closes', async () => {
    const repo = createLibraryRepository(db);
    db.close();
    expect(await repo.remove('instagram:ABC123')).toEqual({ ok: false, error: 'storage-failed' });
  });
});
