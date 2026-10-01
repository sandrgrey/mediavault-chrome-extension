import { describe, expect, it } from 'vitest';
import { selectItems } from '../../src/domain/selectItems';
import { previous, resolved } from '../helpers/domain';

describe('download selection', () => {
  it('retries only the failed element using freshly resolved URLs', () => {
    const result = selectItems('retry', resolved(), previous());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map(x => x.stableItemId)).toEqual(['b']);
  });
  it('explicitly redownloads every item, while normal save prevents duplicates', () => {
    const all = previous(); all.items[1].status = 'completed'; all.items[1].errorCode = null;
    expect(selectItems('save', resolved(), all)).toEqual({ ok: true, value: [] });
    const result = selectItems('redownload', resolved(), all);
    expect(result.ok && result.value.length).toBe(3);
  });
  it('never treats a partial history as a normal fresh save', () => {
    expect(selectItems('save', resolved(), previous())).toEqual({ ok: false, error: 'partial-carousel' });
  });
  it.each([['c', 'b', 'a'], ['a', 'x', 'c'], ['a', 'b'], ['a', 'b', 'c', 'd']])(
    'rejects a changed full snapshot %j', (...ids) => {
      expect(selectItems('retry', resolved(ids), previous())).toEqual({ ok: false, error: 'source-changed' });
    });
  it('does not match items by their old positions without stable identities', () => {
    expect(selectItems('retry', resolved([null, null, null]), previous()))
      .toEqual({ ok: false, error: 'identity-unavailable' });
  });
  it('rejects repeated stable IDs instead of guessing which item succeeded', () => {
    expect(selectItems('retry', resolved(['a', 'a', 'c']), previous()))
      .toEqual({ ok: false, error: 'identity-unavailable' });
  });
  it('can complete a previously partial collected subsequence', () => {
    const old = previous(); old.collectionStatus = 'partial'; old.expectedCount = null;
    old.items = old.items.filter(x => x.stableItemId !== 'b');
    const result = selectItems('retry', resolved(), old);
    expect(result.ok && result.value.map(x => x.stableItemId)).toEqual(['b']);
  });
  it('rejects a different publication regardless of coinciding item IDs', () => {
    expect(selectItems('retry', { ...resolved(), id: 'instagram:OTHER' }, previous()))
      .toEqual({ ok: false, error: 'source-changed' });
  });
});
