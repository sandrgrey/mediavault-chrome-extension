import { expect, it, vi } from 'vitest';
import { createAssociationSession } from '../../src/media/trackAssociation';
import { MAX_CAPTURE_BYTES } from '../../src/media/reelProtocol';
const url = (name: string) => `https://scontent-lax7-1.cdninstagram.com/${name}.mp4?sig=x`;
const bytes = (seed: number) => { let n = seed; return Uint8Array.from({ length: 6000 }, () => { n = (n * 1664525 + 1013904223) >>> 0; return n >>> 24; }); };
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
const make = () => createAssociationSession({ operationId: 'op', token: 'token', deadlineMs: Date.now() + 120000 });
it('associates two disjoint append chunks with reordered range responses, ignoring a neighboring track', async () => {
  const session = make(), v = bytes(1), a = bytes(2), other = bytes(3);
  session.observeAppend('video', v.subarray(0, 2048)); session.observeAppend('video', v.subarray(2048, 4096));
  session.observeAppend('audio', a); session.observeAppend('neighbor', other);
  await session.observeResponse(url('other'), stream(other));
  await session.observeResponse(url('a'), stream(a));
  await session.observeResponse(url('v') + '&bytestart=2048&byteend=5999', stream(v.subarray(2048)));
  await session.observeResponse(url('v') + '&bytestart=0&byteend=2047', stream(v.subarray(0, 2048)));
  expect(session.resolve('video', 'audio')).toEqual({ ok: true, value: { videoUrl: url('v'), audioUrl: url('a') } });
  session.dispose();
  expect(session.resolve('video', 'audio').ok).toBe(false);
});
it('refuses duplicate resources and one repeated chunk does not count as two matches', async () => {
  const session = make(), v = bytes(1), a = bytes(2);
  session.observeAppend('v', v.subarray(0, 2048)); session.observeAppend('v', v.subarray(0, 2048)); session.observeAppend('a', a);
  await session.observeResponse(url('v'), stream(v)); await session.observeResponse(url('a'), stream(a));
  expect(session.resolve('v', 'a').ok).toBe(false);
  session.observeAppend('v', v.subarray(2048, 4096));
  await session.observeResponse(url('duplicate'), stream(v));
  expect(session.resolve('v', 'a').ok).toBe(false);
  session.dispose();
});
it('cancels never-ending capture without awaiting a hanging cancel promise', async () => {
  const session = make(); let cancelled = false;
  const pending = session.observeResponse(url('v'), new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }));
  session.dispose(); await pending;
  expect(cancelled).toBe(true);
});
it('enforces total byte budget and clears references on timeout', async () => {
  vi.useFakeTimers();
  try {
    const session = make();
    await session.observeResponse(url('huge'), stream(new Uint8Array(MAX_CAPTURE_BYTES + 1)));
    expect(session.resolve('v', 'a')).toEqual({ ok: false, error: 'too-many-items' });
    const expiring = make();
    await vi.advanceTimersByTimeAsync(120001);
    expect(expiring.resolve('v', 'a')).toEqual({ ok: false, error: 'collection-timeout' });
    session.dispose(); expiring.dispose();
  } finally { vi.useRealTimers(); }
});

