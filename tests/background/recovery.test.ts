import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openMediaVaultDatabase, type MediaVaultDatabase } from '../../src/storage/database';
import { createOperationRepository } from '../../src/storage/operations';
import { createRecovery } from '../../src/background/recovery';
import type { DownloadSnapshot, DownloadsPort } from '../../src/download/chromeDownloads';
import type { OperationRecord } from '../../src/domain/models';
import { operation } from '../helpers/domain';

let db: MediaVaultDatabase;
beforeEach(async () => { db = await openMediaVaultDatabase(`recovery-${crypto.randomUUID()}`); });
afterEach(() => db.close());
const now = Date.parse('2026-10-01T12:00:00Z');
function downloads(states: Record<number, DownloadSnapshot['state']> = {}): DownloadsPort {
  return { start: vi.fn(async () => { throw Error('Recovery must never start downloads'); }),
    get: vi.fn(async (id: number): Promise<DownloadSnapshot | null> => states[id] ? { id, state: states[id], filename: 'unused', errorCode: states[id] === 'interrupted' ? 'download-failed' : null } : null),
    onChange: () => () => undefined };
}
function pending(): OperationRecord {
  const op = operation();
  op.items = op.items.map(item => ({ ...item, status: 'pending', downloadId: null, errorCode: null }));
  return op;
}
async function seed(op: OperationRecord) {
  await db.put('operations', op);
  await db.put('activePublications', { publicationId: op.publicationId, operationId: op.id });
  return createOperationRepository(db);
}
it('reconciles completed IDs into the library but never restarts pending files after wakeup', async () => {
  const op = pending(); op.items[0].status = 'downloading'; op.items[0].downloadId = 7;
  const repo = await seed(op), port = downloads({ 7: 'complete' });
  expect(await createRecovery(repo, port, () => now)()).toEqual({ ok: true, value: undefined });
  const saved = (await repo.get(op.id))!;
  expect(saved.items.map(i => i.status)).toEqual(['completed', 'pending', 'pending']);
  expect(saved.state).toBe('needs-user');
  expect((await db.get('publications', op.publicationId))?.items[0].status).toBe('completed');
  expect(await db.get('activePublications', op.publicationId)).toBeUndefined();
  expect(port.start).not.toHaveBeenCalled();
});
it('keeps dispatching without an ID uncertain and reserves the publication', async () => {
  const op = pending(); op.items[0].status = 'dispatching';
  const repo = await seed(op), port = downloads();
  await createRecovery(repo, port, () => now)();
  expect((await repo.get(op.id))?.items[0].status).toBe('uncertain');
  expect((await repo.get(op.id))?.state).toBe('uncertain');
  expect(await db.get('activePublications', op.publicationId)).toBeDefined();
  expect(port.start).not.toHaveBeenCalled();
});
it('treats erased Chrome history as uncertain rather than failed or eligible for replay', async () => {
  const op = pending(); op.items[0].status = 'downloading'; op.items[0].downloadId = 7;
  const repo = await seed(op);
  await createRecovery(repo, downloads(), () => now)();
  expect((await repo.get(op.id))?.items[0]).toMatchObject({ status: 'uncertain', errorCode: 'needs-review' });
  expect((await repo.get(op.id))?.state).toBe('uncertain');
});
it('keeps a known active download reserved and rechecks an uncertain ID', async () => {
  const op = pending(); op.state = 'uncertain'; op.items[0].status = 'uncertain'; op.items[0].downloadId = 7;
  const repo = await seed(op), port = downloads({ 7: 'in_progress' });
  await createRecovery(repo, port, () => now)();
  expect((await repo.get(op.id))?.items[0].status).toBe('downloading');
  expect((await repo.get(op.id))?.state).toBe('downloading');
  expect(await db.get('activePublications', op.publicationId)).toBeDefined();
});
it('preserves a collecting reservation until its deadline and expires it afterwards', async () => {
  const op = pending(); op.state = 'collecting'; op.items = []; op.metadata = null; op.collectDeadlineMs = now;
  const repo = await seed(op);
  await createRecovery(repo, downloads(), () => now)();
  expect((await repo.get(op.id))?.state).toBe('collecting');
  await createRecovery(repo, downloads(), () => now + 1)();
  expect((await repo.get(op.id))?.state).toBe('needs-user');
});
it('settles a complete set idempotently and never claims full success for partial collection', async () => {
  const op = pending(); op.items = op.items.map((item, index) => ({ ...item, status: 'downloading', downloadId: index }));
  const repo = await seed(op), port = downloads({ 0: 'complete', 1: 'complete', 2: 'complete' });
  const recover = createRecovery(repo, port, () => now);
  await recover();
  const first = await db.get('publications', op.publicationId);
  await recover();
  expect((await repo.get(op.id))?.state).toBe('completed');
  expect(await db.get('publications', op.publicationId)).toEqual(first);
  op.collectionStatus = 'partial'; op.expectedCount = null;
  await seed(op);
  await recover();
  expect((await repo.get(op.id))?.state).toBe('partial');
});
it('records interruption without deleting another successful file', async () => {
  const op = pending(); op.items = op.items.slice(0, 2); op.expectedCount = 2;
  op.items.forEach((item, i) => { item.status = 'downloading'; item.downloadId = i; });
  const repo = await seed(op);
  await createRecovery(repo, downloads({ 0: 'complete', 1: 'interrupted' }), () => now)();
  expect((await repo.get(op.id))?.state).toBe('partial');
  expect((await db.get('publications', op.publicationId))?.items.map(i => i.status)).toEqual(['completed', 'failed']);
});
it('finishes cancellation after accounting for already running files', async () => {
  const op = pending(); op.items[0].status = 'downloading'; op.items[0].downloadId = 7;
  const repo = await seed(op);
  await repo.requestCancel(op.id);
  await createRecovery(repo, downloads({ 7: 'complete' }), () => now)();
  expect((await repo.get(op.id))?.state).toBe('cancelled');
  expect((await db.get('publications', op.publicationId))?.items[0].status).toBe('completed');
  expect(await db.get('activePublications', op.publicationId)).toBeUndefined();
});
it('leaves superseded operations alone', async () => {
  const op = pending(); op.superseded = true; op.state = 'uncertain';
  const repo = await seed(op), port = downloads();
  await createRecovery(repo, port, () => now)();
  expect(await repo.get(op.id)).toEqual(op);
  expect(port.get).not.toHaveBeenCalled();
});
it('returns safe API failure without changing known active items or starting more files', async () => {
  const op = pending(); op.items[0].status = 'downloading'; op.items[0].downloadId = 7;
  const repo = await seed(op), port = downloads();
  vi.mocked(port.get).mockRejectedValue(Error('PRIVATE'));
  expect(await createRecovery(repo, port, () => now)()).toEqual({ ok: false, error: 'download-failed' });
  expect(await repo.get(op.id)).toEqual(op);
  expect(port.start).not.toHaveBeenCalled();
});

it('serializes overlapping wakeups and processes a newer Chrome snapshot', async () => {
  const op = pending(); op.items[0].status = 'downloading'; op.items[0].downloadId = 7;
  const repo = await seed(op), port = downloads({ 7: 'complete' });
  let release!: (snapshot: DownloadSnapshot) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(port.get).mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const recover = createRecovery(repo, port, () => now);
  const first = recover();
  await started;
  const second = recover();
  release({ id: 7, state: 'in_progress', filename: 'unused', errorCode: null });
  expect(await first).toEqual({ ok: true, value: undefined });
  expect(await second).toEqual({ ok: true, value: undefined });
  expect((await repo.get(op.id))?.items[0].status).toBe('completed');
  expect((await repo.get(op.id))?.state).toBe('needs-user');
});

it('does not settle or release the reservation when journal update fails', async () => {
  const op = pending(); op.items[0].status = 'downloading'; op.items[0].downloadId = 7;
  const repo = await seed(op);
  vi.spyOn(repo, 'transitionItem').mockResolvedValue({ ok: false, error: 'storage-failed' });
  expect(await createRecovery(repo, downloads({ 7: 'complete' }), () => now)()).toEqual({ ok: false, error: 'storage-failed' });
  expect(await repo.get(op.id)).toEqual(op);
  expect(await db.get('activePublications', op.publicationId)).toBeDefined();
});

it('returns a safe storage error when the database is closed', async () => {
  const repo = await seed(pending());
  db.close();
  expect(await createRecovery(repo, downloads(), () => now)()).toEqual({ ok: false, error: 'storage-failed' });
});
