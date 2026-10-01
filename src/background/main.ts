import { openMediaVaultDatabase } from '../storage/database';
import { createOperationRepository } from '../storage/operations';
import { createReloadRepository } from '../storage/reloadIntents';
import { createChromeDownloads } from '../download/chromeDownloads';
import { createRecovery } from './recovery';
import { createOperationQueue } from './operationQueue';
import { createReelCoordinator } from './reelCoordinator';
import { parseReelMessage, senderOwner, senderDocumentOwner } from '../shared/reelMessages';
import { reelIdentity } from '../providers/instagram/reelIdentity';
import { fail } from '../shared/result';

const downloads = createChromeDownloads();
async function createRuntime() {
  const db = await openMediaVaultDatabase(), operations = createOperationRepository(db), reloads = createReloadRepository(db);
  const queue = createOperationQueue(), live = new Set<string>();
  const recover = createRecovery(operations, downloads, Date.now, { queue, live });
  const coordinator = createReelCoordinator({ operations, reloads, downloads, queue, live, recover, now: Date.now,
    verifyContext: async (owner, identity, operationId) => {
      try {
        const tab = await chrome.tabs.get(owner.tabId), current = reelIdentity(tab.url ?? '');
        if (!current.ok || current.value.publicationId !== identity.publicationId) return false;
        const reply = await chrome.tabs.sendMessage(owner.tabId, { version: 1, type: 'reel-context-probe', operationId }, { documentId: owner.documentId });
        return reply?.valid === true;
      } catch { return false; }
    },
    reloadTab: id => chrome.tabs.reload(id), cancelDownload: id => chrome.downloads.cancel(id) });
  return { coordinator, recover, operations, live };
}
let runtime: Promise<Awaited<ReturnType<typeof createRuntime>>> | undefined;
function ready() {
  runtime ??= createRuntime().catch(error => { runtime = undefined; throw error; });
  return runtime;
}
async function recover() { try { await (await ready()).recover(); } catch { /* no raw browser data in logs */ } }
downloads.onChange(() => { void recover(); });
chrome.runtime.onMessage.addListener((input, sender, reply) => {
  const message = parseReelMessage(input);
  if (!message) { reply(fail('invalid-message')); return; }
  void (async () => {
    try {
      if (sender.tab?.id === undefined) { reply(fail('invalid-message')); return; }
      if (message.type === 'reel-cancel' || message.type === 'reel-status') {
        const owner = senderDocumentOwner(sender, chrome.runtime.id);
        if (!owner.ok) { reply(owner); return; }
        const { coordinator } = await ready();
        reply(await (message.type === 'reel-cancel' ? coordinator.cancel(owner.value, message.operationId) : coordinator.status(owner.value, message.operationId)));
        return;
      }
      const tab = await chrome.tabs.get(sender.tab.id);
      const context = senderOwner(sender, tab.url ?? '', chrome.runtime.id);
      if (!context.ok) { reply(context); return; }
      const { owner, identity } = context.value, { coordinator } = await ready();
      switch (message.type) {
        case 'reel-begin': reply(await coordinator.begin(owner, identity, message.requestId, message.mode)); break;
        case 'reel-claim': reply(await coordinator.claim(owner, identity)); break;
        case 'reel-submit': reply(await coordinator.submit(owner, identity, message.result)); break;
      }
    } catch { reply(fail('storage-failed')); }
  })();
  return true;
});
async function invalidate(tabId: number, checkDocument = false) {
  try {
    const current = await ready();
    for (const op of await current.operations.findRecoverable()) if (op.owner.tabId === tabId && current.live.has(op.id)) {
      if (checkDocument) {
        try {
          const reply = await chrome.tabs.sendMessage(tabId, { version: 1, type: 'reel-owner-probe' }, { documentId: op.owner.documentId });
          if (reply?.alive === true) continue;
        } catch { /* the owning document no longer exists */ }
      }
      await current.coordinator.cancel(op.owner, op.id);
    }
  } catch { /* recovery handles any durable download */ }
}
chrome.tabs.onRemoved.addListener(id => { void invalidate(id); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete') void invalidate(id, true); });
void recover();
chrome.action.onClicked.addListener(() => { void chrome.tabs.create({ url: chrome.runtime.getURL('library.html') }); });
