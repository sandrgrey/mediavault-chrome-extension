type DownloadResult = { ok: true } | { ok: false; error: 'download-failed' | 'cancelled' };

export async function downloadMergedBlob(blob: Blob, signal?: AbortSignal): Promise<DownloadResult> {
  if (signal?.aborted) return { ok: false, error: 'cancelled' };
  let url: string;
  try { url = URL.createObjectURL(blob); }
  catch { return { ok: false, error: 'download-failed' }; }
  return new Promise(resolve => {
    let id: number | undefined;
    let settled = false;
    let cancelling = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      signal?.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(url);
      resolve(signal?.aborted ? { ok: false, error: 'cancelled' }
        : ok ? { ok: true } : { ok: false, error: 'download-failed' });
    };
    const inspect = async () => {
      if (id === undefined || settled) return;
      try {
        const [item] = await chrome.downloads.search({ id });
        if (!item || item.state === 'interrupted') finish(false);
        else if (item.state === 'complete') finish(true);
      } catch {
        // A failed search does not prove Chrome has stopped reading the Blob.
        // Cancel first; only successful cancellation or a terminal event releases it.
        void cancel();
      }
    };
    const cancel = async () => {
      if (id === undefined || settled || cancelling) return;
      cancelling = true;
      try { await chrome.downloads.cancel(id); finish(false); }
      catch { /* Keep listening: cancellation failure is not terminal. */ }
      finally { cancelling = false; }
    };
    function onChanged(delta: chrome.downloads.DownloadDelta) {
      if (delta.id !== id || settled) return;
      if (delta.state?.current === 'complete') finish(true);
      else if (delta.state?.current === 'interrupted') finish(false);
      else void inspect();
    }
    function onAbort() { void cancel(); }
    chrome.downloads.onChanged.addListener(onChanged);
    signal?.addEventListener('abort', onAbort, { once: true });
    void (async () => {
      try {
        id = await chrome.downloads.download({ url, filename: 'MediaVault/merged.mp4', conflictAction: 'uniquify', saveAs: false });
        if (signal?.aborted) await cancel();
        else await inspect();
      } catch { finish(false); }
    })();
  });
}
