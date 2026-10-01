import { reelIdentity } from '../providers/instagram/reelIdentity';
import { mediaUrl, parseBridgeMessage } from './reelProtocol';
import { createAssociationSession } from './trackAssociation';
import type { ReelSession } from '../storage/reloadIntents';
import type { MediaVaultErrorCode } from '../shared/result';

type Track = { key: string; mime: string };
export function installPageBridge(): { dispose(): void } {
  const sources = new WeakMap<MediaSource, Track[]>(), buffers = new WeakMap<SourceBuffer, Track>();
  const blobs = new Map<string, WeakRef<MediaSource>>();
  let serial = 0;
  let active: { session: ReelSession; identity: string; pending: number; capture: ReturnType<typeof createAssociationSession> } | null = null;
  const nativeFetch = window.fetch, nativeCreate = URL.createObjectURL, nativeRevoke = URL.revokeObjectURL;
  const nativeAdd = MediaSource.prototype.addSourceBuffer, nativeAppend = SourceBuffer.prototype.appendBuffer;
  function stop(error?: MediaVaultErrorCode) {
    const previous = active; active = null;
    if (!previous) return;
    previous.capture.dispose();
    if (error) window.postMessage({ version: 1, type: 'failed', operationId: previous.session.operationId, token: previous.session.token, error }, location.origin);
  }
  const create: typeof URL.createObjectURL = function (this: typeof URL, object) {
    const url = nativeCreate.call(this, object);
    if (object instanceof MediaSource) {
      if (blobs.size >= 128) blobs.delete(blobs.keys().next().value!);
      blobs.set(url, new WeakRef(object)); sources.set(object, []);
    }
    return url;
  };
  const revoke: typeof URL.revokeObjectURL = function (this: typeof URL, url) { blobs.delete(url); return nativeRevoke.call(this, url); };
  const add: typeof MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime) {
    const buffer = nativeAdd.call(this, mime);
    const track = { key: String(++serial), mime };
    const tracks = sources.get(this) ?? []; tracks.push(track); sources.set(this, tracks); buffers.set(buffer, track);
    return buffer;
  };
  const append: typeof SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, value) {
    const result = nativeAppend.call(this, value);
    const track = buffers.get(this);
    if (active && track) {
      try {
        const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
        active.capture.observeAppend(track.key, bytes);
      } catch { stop('unavailable'); }
    }
    return result;
  };
  const fetchHook: typeof fetch = function (this: Window, ...args) {
    const current = active;
    const promise = nativeFetch.apply(this, args);
    if (current) {
      current.pending++;
      void promise.then(async response => {
      if (active !== current || !mediaUrl(response.url) || !response.ok) return;
      const clone = response.clone();
        if (clone.body) await current.capture.observeResponse(response.url, clone.body);
      }).catch(() => undefined).finally(() => { current.pending--; });
    }
    return promise;
  };
  URL.createObjectURL = create; URL.revokeObjectURL = revoke;
  MediaSource.prototype.addSourceBuffer = add; SourceBuffer.prototype.appendBuffer = append; window.fetch = fetchHook;
  function message(event: MessageEvent) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = parseBridgeMessage(event.data); if (!data) return;
    if (data.type === 'cancel') { if (active?.session.operationId === data.operationId) stop('cancelled'); return; }
    if (active) return;
    const identity = reelIdentity(location.href);
    if (!identity.ok || data.session.deadlineMs <= Date.now()) return;
    active = { session: data.session, identity: identity.value.publicationId, pending: 0, capture: createAssociationSession(data.session) };
  }
  window.addEventListener('message', message);
  function check() {
    if (!active) return;
    const identity = reelIdentity(location.href);
    if (!identity.ok || identity.value.publicationId !== active.identity) { stop('publication-changed'); return; }
    const candidates = [...document.querySelectorAll('video')].filter(video => {
      const r = video.getBoundingClientRect();
      const width = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const height = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return r.width >= 64 && r.height >= 64 && width * height >= r.width * r.height * 0.75;
    });
    if (candidates.length > 1) { stop('unavailable'); return; }
    const media = candidates[0] && blobs.get(candidates[0].currentSrc)?.deref();
    const tracks = media ? sources.get(media) ?? [] : [];
    const video = tracks.filter(track => track.mime.startsWith('video/')), audio = tracks.filter(track => track.mime.startsWith('audio/'));
    const result = active.capture.resolve(video.length === 1 ? video[0].key : '', audio.length === 1 ? audio[0].key : '');
    if (result.ok) {
      if (active.pending) return;
      const session = active.session;
      stop();
      window.postMessage({ version: 1, type: 'ready', operationId: session.operationId, token: session.token, pair: result.value }, location.origin);
    } else if (result.error !== 'unavailable') stop(result.error);
  }
  const interval = setInterval(check, 100);
  const leaving = () => stop('publication-changed');
  window.addEventListener('pagehide', leaving);
  return { dispose() {
    stop(); clearInterval(interval); blobs.clear();
    window.removeEventListener('message', message); window.removeEventListener('pagehide', leaving);
    if (window.fetch === fetchHook) window.fetch = nativeFetch;
    if (URL.createObjectURL === create) URL.createObjectURL = nativeCreate;
    if (URL.revokeObjectURL === revoke) URL.revokeObjectURL = nativeRevoke;
    if (MediaSource.prototype.addSourceBuffer === add) MediaSource.prototype.addSourceBuffer = nativeAdd;
    if (SourceBuffer.prototype.appendBuffer === append) SourceBuffer.prototype.appendBuffer = nativeAppend;
  } };
}
