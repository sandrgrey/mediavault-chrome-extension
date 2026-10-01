import { openMediaVaultDatabase } from '../storage/database';
import { createOperationRepository } from '../storage/operations';
import { createChromeDownloads } from '../download/chromeDownloads';
import { createRecovery } from './recovery';

const downloads = createChromeDownloads();
let recovery: Promise<ReturnType<typeof createRecovery>> | undefined;
async function recover() {
  try {
    recovery ??= openMediaVaultDatabase().then(db => createRecovery(createOperationRepository(db), downloads));
    await (await recovery)();
  } catch {
    // Database open can be retried on the next event; never log raw browser data.
    recovery = undefined;
  }
}

// MV3 listeners must be registered before asynchronous database initialization.
downloads.onChange(() => { void recover(); });
void recover();

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
});
