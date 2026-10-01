import { describe, expect, it } from 'vitest';
import { toPublicationRecord } from '../../src/domain/persistence';
import { operation, previous } from '../helpers/domain';

const now = '2026-01-03T00:00:00.000Z';
describe('privacy-safe library projection', () => {
  it('writes completed and failed items in order without sensitive extra fields', () => {
    const op = operation();
    Object.assign(op.metadata!, { headers: { authorization: 'FORBIDDEN_FIXTURE' }, html: '<private>' });
    Object.assign(op.items[0], { downloadUrl: 'https://fixture.invalid/?temporary=FORBIDDEN_FIXTURE' });
    const result = toPublicationRecord(op, null, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map(x => x.index)).toEqual([0, 1, 2]);
    expect(result.value.items.map(x => x.status)).toEqual(['completed', 'failed', 'completed']);
    expect(result.value.savedAt).toBe(now);
    expect(JSON.stringify(result.value)).not.toMatch(/downloadUrl|authorization|FORBIDDEN_FIXTURE|"html"/);
  });
  it('rejects a new record with no successful files', () => {
    const op = operation(); for (const item of op.items) item.status = 'failed';
    expect(toPublicationRecord(op, null, now)).toEqual({ ok: false, error: 'storage-empty-record' });
  });
  it('does not erase previous successes when redownload fails', () => {
    const op = operation(); op.mode = 'redownload';
    for (const item of op.items) item.status = 'failed';
    const result = toPublicationRecord(op, previous(), now);
    expect(result.ok && result.value.items[0].status).toBe('completed');
    expect(result.ok && result.value.savedAt).toBe('2026-01-01T00:00:00.000Z');
  });
  it('keeps an old successful snapshot during incomplete redownload of a changed composition', () => {
    const op = operation(); op.mode = 'redownload'; op.items[0].stableItemId = 'new';
    const result = toPublicationRecord(op, previous(), now);
    expect(result.ok && result.value.items).toEqual(previous().items);
  });
  it('replaces the old snapshot only once the new composition fully succeeds', () => {
    const op = operation(); op.mode = 'redownload'; op.items[0].stableItemId = 'new';
    for (const item of op.items) { item.status = 'completed'; item.errorCode = null; }
    const result = toPublicationRecord(op, previous(), now);
    expect(result.ok && result.value.items[0].stableItemId).toBe('new');
  });
  it('preserves uncertainty about the complete carousel even when all found files complete', () => {
    const op = operation(); op.collectionStatus = 'partial'; op.expectedCount = null;
    for (const item of op.items) item.status = 'completed';
    const result = toPublicationRecord(op, null, now);
    expect(result.ok && result.value.collectionStatus).toBe('partial');
  });
  it('projects in-flight items as incomplete rather than completed', () => {
    const op = operation(); op.items[1].status = 'downloading';
    const result = toPublicationRecord(op, null, now);
    expect(result.ok && result.value.items[1].status).toBe('failed');
  });
  it('rejects mismatched publication metadata', () => {
    const op = operation(); op.metadata!.id = 'instagram:OTHER';
    expect(toPublicationRecord(op, null, now)).toEqual({ ok: false, error: 'invalid-message' });
  });
});
