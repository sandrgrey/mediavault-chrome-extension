import type { OperationRepository } from '../storage/operations';
import type { DownloadsPort } from '../download/chromeDownloads';
import type { ItemState, OperationState } from '../domain/models';
import { fail, ok, type Result } from '../shared/result';

export function createRecovery(operations: OperationRepository, downloads: DownloadsPort, now = Date.now) {
  // Serialize calls; a later download event must perform a fresh pass, not reuse
  // an earlier search snapshot. This function never has access to media URLs.
  let queue: Promise<Result<void>> = Promise.resolve(ok(undefined));
  async function recover(): Promise<Result<void>> {
    try {
      for (const operation of await operations.findRecoverable()) {
        if (operation.state === 'collecting') {
          if (operation.collectDeadlineMs < now()) {
            const result = await operations.settle(operation.id, 'needs-user', new Date(now()).toISOString());
            if (!result.ok) return result;
          }
          continue;
        }
        for (const item of operation.items) {
          if (!['dispatching', 'downloading', 'uncertain'].includes(item.status)) continue;
          let from = item.status;
          if (item.downloadId === null) {
            if (from !== 'uncertain') {
              const result = await operations.transitionItem(operation.id, item.index, from, 'uncertain', { errorCode: 'needs-review' });
              if (!result.ok) return result;
            }
            continue;
          }
          let snapshot;
          try { snapshot = await downloads.get(item.downloadId); }
          catch { return fail('download-failed'); }
          if (from === 'dispatching' && snapshot) {
            const result = await operations.transitionItem(operation.id, item.index, from, 'downloading', {});
            if (!result.ok) return result;
            from = 'downloading';
          }
          const to: ItemState = !snapshot ? 'uncertain' : snapshot.state === 'complete' ? 'completed'
            : snapshot.state === 'interrupted' ? 'failed' : 'downloading';
          if (from !== to) {
            const result = await operations.transitionItem(operation.id, item.index, from, to,
              { errorCode: !snapshot ? 'needs-review' : snapshot.errorCode });
            if (!result.ok) return result;
          }
        }
        // Re-read after writes and concurrent cancellation; never derive final
        // status from the stale snapshot taken before querying Chrome.
        const current = await operations.get(operation.id);
        if (!current || current.superseded) continue;
        let state: OperationState;
        if (current.items.some(item => item.status === 'uncertain' || item.status === 'dispatching')) state = 'uncertain';
        else if (current.items.some(item => item.status === 'downloading')) state = current.cancelRequested ? 'stopping' : 'downloading';
        else if (current.items.some(item => item.status === 'pending')) state = 'needs-user';
        else if (current.collectionStatus === 'complete' && current.items.length > 0 && current.expectedCount === current.items.length &&
          current.items.every(item => item.status === 'completed')) state = 'completed';
        else if (current.cancelRequested) state = 'cancelled';
        else state = current.items.some(item => item.status === 'completed') ? 'partial' : 'failed';
        if (state !== current.state) {
          const result = await operations.settle(current.id, state, new Date(now()).toISOString());
          if (!result.ok) return result;
        }
      }
      return ok(undefined);
    } catch { return fail('storage-failed'); }
  }
  return (): Promise<Result<void>> => { queue = queue.then(recover); return queue; };
}
