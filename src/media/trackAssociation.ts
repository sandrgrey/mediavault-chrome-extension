import type { ReelSession } from '../storage/reloadIntents';
import { MAX_CAPTURE_BYTES, mediaUrl, type TrackPair } from './reelProtocol';
import { fail, ok, type Result, type MediaVaultErrorCode } from '../shared/result';
type Body = { key: string; url: string; offset: number; complete: boolean; chunks: Uint8Array[] };
// KMP walks fragmented response data without allocating a second full body.
function find(chunks: Uint8Array[], sample: Uint8Array): number {
  const prefix = new Uint32Array(sample.length);
  for (let i = 1, j = 0; i < sample.length; i++) {
    while (j && sample[i] !== sample[j]) j = prefix[j - 1];
    if (sample[i] === sample[j]) j++;
    prefix[i] = j;
  }
  let position = 0, matched = 0;
  for (const chunk of chunks) for (const byte of chunk) {
    while (matched && byte !== sample[matched]) matched = prefix[matched - 1];
    if (byte === sample[matched]) matched++;
    if (matched === sample.length) return position - sample.length + 1;
    position++;
  }
  return -1;
}
export function createAssociationSession(session: ReelSession) {
  const bodies: Body[] = [], appends = new Map<string, Uint8Array[]>(), readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let retained = 0, samples = 0, stopped: MediaVaultErrorCode | null = null;
  const end = (error: MediaVaultErrorCode) => {
    if (stopped) return;
    stopped = error; clearTimeout(timer);
    for (const reader of readers) void reader.cancel().catch(() => undefined);
    readers.clear(); bodies.length = 0; appends.clear(); retained = 0;
  };
  const timer = setTimeout(() => end('collection-timeout'), Math.max(0, Math.min(120000, session.deadlineMs - Date.now())));
  function reserve(size: number): boolean {
    if (stopped) return false;
    if (retained + size > MAX_CAPTURE_BYTES) { end('too-many-items'); return false; }
    retained += size; return true;
  }
  return {
    async observeResponse(value: string, stream: ReadableStream<Uint8Array>): Promise<void> {
      const url = mediaUrl(value);
      if (!url || stopped) { void stream.cancel().catch(() => undefined); return; }
      const offset = Number(new URL(value).searchParams.get('bytestart') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || bodies.length >= 128) { end('unavailable'); void stream.cancel().catch(() => undefined); return; }
      const body: Body = { key: url.origin + url.pathname, url: url.href, offset, complete: false, chunks: [] };
      bodies.push(body);
      const reader = stream.getReader(); readers.add(reader);
      try {
        while (!stopped) {
          const { done, value: bytes } = await reader.read();
          if (done) { body.complete = true; break; }
          if (stopped) break;
          if (!reserve(bytes.byteLength)) break;
          body.chunks.push(bytes.slice());
        }
      } catch { end('unavailable'); }
      finally { readers.delete(reader); reader.releaseLock(); }
    },
    observeAppend(track: string, bytes: Uint8Array): void {
      if (stopped || bytes.length <= 1024) return;
      const chunks = bytes.length >= 4096 ? [bytes.subarray(0, 2048), bytes.subarray(bytes.length - 2048)] : [bytes];
      for (const chunk of chunks) {
        if (++samples > 256) { end('too-many-items'); return; }
        if (!reserve(chunk.byteLength)) return;
        const list = appends.get(track) ?? [];
        list.push(chunk.slice()); appends.set(track, list);
      }
    },
    resolve(video: string, audio: string, silent = false): Result<TrackPair> {
      if (stopped) return fail(stopped);
      const match = (track: string): Body | null => {
        const candidates = new Map<string, { body: Body; ranges: [number, number][] }>();
        for (const sample of appends.get(track) ?? []) for (const body of bodies) {
          const local = find(body.chunks, sample); if (local < 0) continue;
          const start = body.offset + local, finish = start + sample.length;
          const candidate = candidates.get(body.key) ?? { body, ranges: [] };
          if (body.complete && candidate.ranges.every(([a, b]) => finish <= a || start >= b)) {
            candidate.ranges.push([start, finish]); candidate.body = body;
          }
          candidates.set(body.key, candidate);
        }
        // Even a partial match to another resource makes the identification ambiguous.
        if (candidates.size !== 1) return null;
        const [candidate] = candidates.values();
        return candidate.ranges.length >= 2 ? candidate.body : null;
      };
      const v = match(video), a = match(audio);
      if (silent && !audio && v) return ok({ videoUrl: v.url, audioUrl: null });
      return v && a && v.key !== a.key ? ok({ videoUrl: v.url, audioUrl: a.url }) : fail('unavailable');
    },
    dispose(): void { end('cancelled'); },
  };
}
