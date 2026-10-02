import { reelIdentity } from '../providers/instagram/reelIdentity';
import { isExplicitlySilent } from '../providers/instagram/silentReel';
import { mediaUrl, plain, type TrackPair } from '../media/reelProtocol';
import { fetchTrackPair } from '../media/trackFetch';
import { remuxTracks } from '../media/remux';
import type { ReelSession } from '../storage/reloadIntents';
import type { ReelMessage } from '../shared/reelMessages';
import { fail, type Result } from '../shared/result';
import type { BeginOutcome } from '../domain/models';
import type { ReelStatus } from '../background/reelCoordinator';

export type SaveView = { message: string; busy: boolean; canCancel: boolean; redownload: boolean };
export function createReelLifecycle(onChange: (view: SaveView) => void) {
  let state: SaveView = { message: 'Проверка состояния…', busy: true, canCancel: false, redownload: false };
  let operationId: string | null = null, blobUrl: string | null = null, disposed = false, polling = false;
  let controller: AbortController | null = null;
  let player: HTMLVideoElement | null = null, source = '';
  let silent = false;
  const identity = reelIdentity(location.href);
  function visiblePlayers() {
    return [...document.querySelectorAll('video')].filter(video => {
      const r = video.getBoundingClientRect();
      const width = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const height = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return r.width >= 64 && r.height >= 64 && width * height >= r.width * r.height * 0.75;
    });
  }
  function validContext() {
    const current = reelIdentity(location.href), visible = visiblePlayers();
    return !disposed && !controller?.signal.aborted && identity.ok && current.ok &&
      current.value.publicationId === identity.value.publicationId && player?.isConnected &&
      player.currentSrc === source && visible.length === 1 && visible[0] === player && (!silent || isExplicitlySilent(player));
  }
  const set = (patch: Partial<SaveView>) => { state = { ...state, ...patch }; if (!disposed) onChange(state); };
  async function send<T>(message: ReelMessage): Promise<Result<T>> {
    try { return await chrome.runtime.sendMessage(message) as Result<T>; } catch { return fail('extension-updated'); }
  }
  function release() {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
    if (disposed) { clearInterval(timer); window.removeEventListener('beforeunload', beforeUnload); }
  }
  function reflect(result: ReelStatus) {
    if (result.safeToRelease) release();
    const messages: Partial<Record<ReelStatus['state'], string>> = {
      completed: 'MP4 сохранён.', failed: 'Не удалось сохранить MP4.', cancelled: 'Отменено.',
      uncertain: 'Результат требует проверки в загрузках Chrome. Повторное скачивание не запущено.',
      'needs-user': 'Операция прервана. Откройте Reel и начните снова.', stopping: 'Остановка скачивания…', downloading: 'Скачивание MP4…',
    };
    const finished = result.safeToRelease && result.state !== 'collecting';
    set({ message: messages[result.state] ?? 'Сбор дорожек…', busy: !finished,
      canCancel: !finished && result.state !== 'uncertain', redownload: result.state === 'completed' || state.redownload });
  }
  async function poll() {
    if (!operationId || !blobUrl || polling) return;
    polling = true;
    try { const result = await send<ReelStatus>({ version: 1, type: 'reel-status', operationId }); if (result.ok) reflect(result.value); }
    finally { polling = false; }
  }
  function capture(session: ReelSession, signal: AbortSignal): Promise<TrackPair> {
    return new Promise((resolve, reject) => {
      const finish = (pair?: TrackPair) => {
        clearInterval(retry); window.removeEventListener('message', reply); signal.removeEventListener('abort', abort);
        if (pair) resolve(pair); else reject(Error('capture-failed'));
      };
      const abort = () => { window.postMessage({ version: 1, type: 'cancel', operationId: session.operationId }, location.origin); finish(); };
      const reply = (event: MessageEvent) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (plain(data, ['version', 'type', 'operationId', 'token', 'pair', 'playerSrc']) && data.version === 1 && data.type === 'ready' &&
          data.operationId === session.operationId && data.token === session.token &&
          plain(data.pair, ['videoUrl', 'audioUrl']) && mediaUrl(data.pair.videoUrl) && (data.pair.audioUrl === null || mediaUrl(data.pair.audioUrl))) {
          const visible = visiblePlayers();
          if (visible.length !== 1 || !visible[0].currentSrc || visible[0].currentSrc !== data.playerSrc ||
            (player && (player !== visible[0] || source !== data.playerSrc))) { finish(); return; }
          player = visible[0]; source = player.currentSrc;
          silent = data.pair.audioUrl === null;
          if (silent && !isExplicitlySilent(player)) { finish(); return; }
          finish(data.pair as TrackPair);
        }
        else if (plain(data, ['version', 'type', 'operationId', 'token', 'error']) && data.version === 1 && data.type === 'failed' &&
          data.operationId === session.operationId && data.token === session.token) finish();
      };
      const activate = () => window.postMessage({ version: 1, type: 'activate', session }, location.origin);
      window.addEventListener('message', reply); signal.addEventListener('abort', abort, { once: true });
      const retry = setInterval(activate, 100);
      if (signal.aborted) abort(); else activate();
    });
  }
  async function run(session: ReelSession) {
    operationId = session.operationId; controller = new AbortController();
    const signal = controller.signal;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller?.abort(); }, Math.max(0, Math.min(120000, session.deadlineMs - Date.now())));
    let submitted = false;
    set({ busy: true, canCancel: true, message: 'Сбор дорожек…' });
    try {
      const pair = await capture(session, signal);
      if (signal.aborted || !validContext()) throw Error('context-changed');
      set({ message: silent ? 'Получение видео без звука…' : 'Получение видео и звука…' });
      const tracks = await fetchTrackPair(pair, signal);
      if (!tracks.ok || !validContext()) throw Error('fetch-failed');
      set({ message: silent ? 'Сохранение видео без звука…' : 'Объединение видео и звука…' });
      const merged = await remuxTracks(tracks.value.video, tracks.value.audio, { signal, onProgress: value => set({ message: `${silent ? 'Видео без звука' : 'Объединение'}: ${Math.round(value * 100)}%` }) });
      if (!merged.ok || signal.aborted || !validContext()) throw Error('remux-failed');
      const current = reelIdentity(location.href);
      if (!identity.ok || !current.ok || current.value.publicationId !== identity.value.publicationId) throw Error('route-changed');
      blobUrl = URL.createObjectURL(merged.value); submitted = true;
      set({ message: 'Скачивание MP4…' });
      const result = await send<ReelStatus>({ version: 1, type: 'reel-submit',
        result: { operationId, blobUrl, size: merged.value.size, mime: 'video/mp4' } });
      if (result.ok) reflect(result.value);
      else { set({ message: 'Проверка результата скачивания…' }); await poll(); }
    } catch {
      if (!submitted) {
        release();
        await send({ version: 1, type: 'reel-cancel', operationId: session.operationId });
        set({ message: timedOut ? 'Не удалось подтвердить видео и звук за отведённое время.' : signal.aborted ? 'Отменено.' : 'Не удалось однозначно получить дорожки Reel.', busy: false, canCancel: false });
      }
    } finally { clearTimeout(deadline); }
  }
  async function cancel() {
    controller?.abort();
    if (!operationId) return;
    const result = await send<ReelStatus>({ version: 1, type: 'reel-cancel', operationId });
    if (result.ok) reflect(result.value);
  }
  const timer = setInterval(() => {
    if (controller && !controller.signal.aborted) {
      const current = reelIdentity(location.href);
      if (!identity.ok || !current.ok || identity.value.publicationId !== current.value.publicationId) { void cancel(); return; }
      const visible = visiblePlayers();
      if (!player && visible.length === 1 && visible[0].currentSrc) { player = visible[0]; source = player.currentSrc; }
      else if (player && (visible.length !== 1 || visible[0] !== player || player.currentSrc !== source)) void cancel();
    }
    void poll();
  }, 300);
  const beforeUnload = (event: BeforeUnloadEvent) => { if (blobUrl) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  void send<ReelSession | null>({ version: 1, type: 'reel-claim' }).then(result => {
    if (disposed) return;
    if (result.ok && result.value) void run(result.value);
    else set({ busy: false, message: 'Готово к сохранению.' });
  });
  return {
    snapshot: () => state,
    isCurrent: (id: string) => operationId === id && Boolean(validContext()),
    async save() {
      if (state.busy) return;
      set({ busy: true, message: 'Перезагрузка страницы…' });
      const result = await send<BeginOutcome>({ version: 1, type: 'reel-begin', requestId: crypto.randomUUID(), mode: state.redownload ? 'redownload' : 'save' });
      if (!result.ok) set({ busy: false, message: 'Не удалось начать сохранение.' });
      else if (result.value.kind !== 'accepted') set({ busy: false, redownload: ['already-saved', 'retry-required', 'needs-review'].includes(result.value.kind),
        message: result.value.kind === 'already-saved' ? 'Уже сохранено.' : 'Нужна явная повторная загрузка или завершение текущей операции.' });
    },
    cancel,
    dispose() {
      disposed = true; controller?.abort();
      if (!blobUrl) { clearInterval(timer); window.removeEventListener('beforeunload', beforeUnload); }
      if (operationId && state.busy) void cancel();
    },
  };
}
