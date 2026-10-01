import type { MediaVaultErrorCode } from '../shared/result';

export type DownloadSnapshot = { id: number; state: 'in_progress' | 'complete' | 'interrupted'; filename: string; errorCode: MediaVaultErrorCode | null };
export interface DownloadsPort {
  start(url: string, filename: string): Promise<number>;
  get(id: number): Promise<DownloadSnapshot | null>;
  onChange(listener: (id: number) => void): () => void;
}
export function createChromeDownloads(): DownloadsPort {
  return {
    async start(url, filename) {
      try { return await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }); }
      catch { throw new Error('download-failed'); }
    },
    async get(id) {
      try {
        const [item] = await chrome.downloads.search({ id });
        if (!item) return null;
        return { id: item.id, state: item.state, filename: item.filename,
          errorCode: item.state === 'interrupted' ? 'download-failed' : null };
      } catch { throw new Error('download-failed'); }
    },
    onChange(listener) {
      const handler = (delta: chrome.downloads.DownloadDelta) => listener(delta.id);
      chrome.downloads.onChanged.addListener(handler);
      return () => chrome.downloads.onChanged.removeListener(handler);
    },
  };
}
