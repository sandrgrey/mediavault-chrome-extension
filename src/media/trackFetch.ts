import { fail, ok, type Result } from '../shared/result';
import { MAX_TRACK_BYTES, mediaUrl, type TrackPair } from './reelProtocol';
export async function fetchTrackPair(pair: TrackPair, signal: AbortSignal): Promise<Result<{ video: Blob; audio: Blob | null }>> {
  if (signal.aborted) return fail('cancelled');
  const videoUrl = mediaUrl(pair.videoUrl), audioUrl = mediaUrl(pair.audioUrl);
  if (!videoUrl || (pair.audioUrl !== null && !audioUrl) || (audioUrl && videoUrl.origin + videoUrl.pathname === audioUrl.origin + audioUrl.pathname)) return fail('unavailable');
  let total = 0;
  const blobs: Blob[] = [];
  try {
    for (const url of (audioUrl ? [videoUrl, audioUrl] : [videoUrl])) {
      if (signal.aborted) return fail('cancelled');
      const response = await fetch(url.href, { credentials: 'omit', signal, redirect: 'error' });
      if (response.status !== 200 || !response.body || response.headers.has('Content-Range')) return fail('unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
      const abort = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) { abort(); return fail('cancelled'); }
        for (;;) {
          const { done, value } = await reader.read();
          if (signal.aborted) return fail('cancelled');
          if (done) break;
          total += value.byteLength;
          if (total > MAX_TRACK_BYTES) { abort(); return fail('too-many-items'); }
          chunks.push(value as Uint8Array<ArrayBuffer>);
        }
      } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
      const blob = new Blob(chunks, { type: 'video/mp4' });
      const magic = new Uint8Array(await blob.slice(4, 8).arrayBuffer());
      if (blob.size < 16 || String.fromCharCode(...magic) !== 'ftyp') return fail('unavailable');
      blobs.push(blob);
    }
    return ok({ video: blobs[0], audio: blobs[1] ?? null });
  } catch { return fail(signal.aborted ? 'cancelled' : 'unavailable'); }
}
