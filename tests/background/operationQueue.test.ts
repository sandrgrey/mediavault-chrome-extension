import { expect, it } from 'vitest';
import { createOperationQueue } from '../../src/background/operationQueue';
it('serializes jobs and resumes after a rejection', async () => {
  const queue = createOperationQueue(), seen: string[] = [];
  const a = queue.run(async () => { seen.push('a'); throw Error('safe'); });
  const b = queue.run(async () => { seen.push('b'); return 7; });
  await expect(a).rejects.toThrow(); await expect(b).resolves.toBe(7);
  expect(seen).toEqual(['a', 'b']);
});

