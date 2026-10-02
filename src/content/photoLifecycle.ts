import { collectPhotos, postIdentity } from '../providers/instagram/photos';
import type { BeginOutcome } from '../domain/models';
import type { Result } from '../shared/result';
import type { ReelStatus } from '../background/reelCoordinator';
import type { SaveView } from './reelLifecycle';
export function createPhotoLifecycle(onChange: () => void) {
  let state: SaveView = { busy: false, canCancel: false, redownload: false, message: 'Готово к сохранению фото.' };
  const identity = postIdentity(location.href), urls: string[] = [];
  let id: string | null = null, controller: AbortController | null = null, disposed = false, polling = false, running = false;
  const set = (patch: Partial<SaveView>) => { state = { ...state, ...patch }; if (!disposed) onChange(); };
  const send = async <T,>(message: unknown): Promise<Result<T>> => {
    try { return await chrome.runtime.sendMessage(message); } catch { return { ok: false, error: 'extension-updated' }; }
  };
  const current = () => { const now = postIdentity(location.href); return !disposed && !controller?.signal.aborted && identity.ok && now.ok && now.value.publicationId === identity.value.publicationId; };
  const beforeUnload = (event: BeforeUnloadEvent) => { if (urls.length) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  const release = () => { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; if (disposed) { clearInterval(timer); window.removeEventListener('beforeunload', beforeUnload); } };
  async function poll() {
    if (!id || polling) return;
    const operationId = id;
    polling = true;
    try {
      const status = await send<ReelStatus>({ version: 1, type: 'reel-status', operationId });
      if (!status.ok || id !== operationId) return;
      if (status.value.safeToRelease && !['collecting', 'downloading'].includes(status.value.state)) {
        release(); const complete = status.value.state === 'completed';
        set({ busy: false, canCancel: false, redownload: complete || status.value.state === 'partial', message: complete ? 'Фото сохранены.' : status.value.state === 'partial' ? 'Сохранена часть карусели. Полнота не подтверждена.' : status.value.state === 'cancelled' ? 'Отменено.' : 'Сохранение прервано. Нужна новая попытка.' });
      } else if (status.value.state === 'uncertain') set({ message: 'Проверьте загрузки Chrome. Автоматический повтор отключён.', canCancel: false });
    } finally { polling = false; }
  }
  async function cancel() {
    controller?.abort();
    if (id) await send({ version: 1, type: 'reel-cancel', operationId: id });
    if (!urls.length) set({ busy: false, canCancel: false, message: 'Отменено.' });
    await poll();
  }
  const timer = setInterval(() => { if (state.busy && !current()) void cancel(); if (urls.length) void poll(); }, 400);
  return {
    snapshot: () => state, isCurrent: (operationId: string) => id === operationId && current(), cancel,
    dispose() { disposed = true; if (state.busy) void cancel(); if (!urls.length) release(); },
    async save() {
      if (state.busy || running || !identity.ok || disposed) return;
      running = true; id = null;
      controller = new AbortController(); const signal = controller.signal;
      const deadline = setTimeout(() => controller?.abort(), 120000);
      set({ busy: true, canCancel: true, message: 'Сбор фото…' });
      let submitted = false;
      try {
        const begin = await send<BeginOutcome>({ version: 1, type: 'photo-begin', requestId: crypto.randomUUID(), mode: state.redownload ? 'redownload' : 'save' });
        if (!begin.ok) throw Error('begin');
        if (begin.value.kind !== 'accepted') { set({ busy: false, canCancel: false, redownload: begin.value.kind !== 'busy', message: begin.value.kind === 'already-saved' ? 'Уже сохранено.' : 'Нужна повторная загрузка. Докачка без устойчивых ID недоступна.' }); return; }
        id = begin.value.operationId;
        const result = await collectPhotos({ document, location: () => new URL(location.href), signal, onProgress: p => set({ message: `Найдено ${p.found}${p.expected ? ` из ${p.expected}` : ''}` }) });
        if (!result.ok || !current()) throw Error('collection');
        let total = 0; const blobs: { url: string; size: number }[] = [];
        for (const item of result.value.items) {
          if (!current()) throw Error('context');
          set({ message: `Получение фото ${item.index + 1} из ${result.value.items.length}…` });
          const response = await fetch(item.downloadUrl, { credentials: 'omit', redirect: 'error', signal });
          if (response.status !== 200 || !response.body || response.headers.has('Content-Range')) throw Error('response');
          const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
          try { for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.length; if (total > 64 * 1024 * 1024) { void reader.cancel(); throw Error('size'); } chunks.push(part.value); } }
          finally { reader.releaseLock(); }
          const blob = new Blob(chunks), magic = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
          const kind = magic[0] === 255 && magic[1] === 216 && magic[2] === 255 ? 'jpg' :
            magic[0] === 137 && String.fromCharCode(...magic.slice(1, 4)) === 'PNG' ? 'png' :
            String.fromCharCode(...magic.slice(0, 4)) === 'RIFF' && String.fromCharCode(...magic.slice(8, 12)) === 'WEBP' ? 'webp' : null;
          if (!kind) throw Error('format'); item.extension = kind;
          const url = URL.createObjectURL(blob); urls.push(url); blobs.push({ url, size: blob.size });
        }
        if (!current()) throw Error('context');
        submitted = true; set({ message: 'Скачивание фото…' });
        const dispatched = await send({ version: 1, type: 'photo-submit', operationId: id, publication: result.value, blobs });
        if (!dispatched.ok) await send({ version: 1, type: 'reel-cancel', operationId: id });
        await poll();
      } catch {
        if (!submitted) { release(); if (id) await send({ version: 1, type: 'reel-cancel', operationId: id }); set({ busy: false, canCancel: false, message: signal.aborted ? 'Отменено.' : 'Не удалось подтвердить или получить фото.' }); }
      } finally { clearTimeout(deadline); running = false; }
    },
  };
}
