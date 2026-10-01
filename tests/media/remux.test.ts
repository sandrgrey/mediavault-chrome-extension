import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BlobSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output } from 'mediabunny';
import { remuxTracks } from '../../src/media/remux';

const fixture = async (name: string) => new Blob([await readFile(new URL(`../fixtures/media/${name}.mp4`, import.meta.url))]);
async function inspect(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  try {
    const tracks = await input.getTracks();
    return await Promise.all(tracks.map(async track => {
      const packets: number[][] = [];
      for await (const packet of new EncodedPacketSink(track).packets()) packets.push([...packet.data]);
      return { type: track.type, codec: track.codec, packets, duration: await track.computeDuration() };
    }));
  } finally { input.dispose(); }
}

describe('browser MP4 remux', () => {
  it('preserves a horizontal display flip instead of silently mirroring the picture', async () => {
    const source = new Input({ source: new BlobSource(await fixture('video')), formats: [MP4] });
    let transformed: Blob;
    try {
      const track = (await source.getPrimaryVideoTrack())!;
      const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      const packets = new EncodedVideoPacketSource((await track.getCodec())!);
      output.addVideoTrack(packets, { flip: true });
      await output.start();
      for await (const packet of new EncodedPacketSink(track).packets())
        await packets.add(packet, { decoderConfig: (await track.getDecoderConfig())! });
      packets.close();
      await output.finalize();
      transformed = new Blob([output.target.buffer!]);
    } finally { source.dispose(); }
    const merged = await remuxTracks(transformed, await fixture('audio'));
    if (!merged.ok) throw Error(merged.error);
    const result = new Input({ source: new BlobSource(merged.value), formats: [MP4] });
    try { expect(await (await result.getPrimaryVideoTrack())!.getFlip()).toBe(true); }
    finally { result.dispose(); }
  });
  it('copies encoded video and audio packets into one MP4 without transcoding', async () => {
    const video = await fixture('video'), audio = await fixture('audio');
    const progress: number[] = [];
    const result = await remuxTracks(video, audio, { onProgress: value => progress.push(value) });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error);
    expect(result.value.type).toBe('video/mp4');
    const tracks = await inspect(result.value);
    expect(tracks.map(t => t.type).sort()).toEqual(['audio', 'video']);
    expect(tracks.find(t => t.type === 'video')?.packets).toEqual((await inspect(video))[0].packets);
    expect(tracks.find(t => t.type === 'audio')?.packets).toEqual((await inspect(audio))[0].packets);
    expect(tracks.find(t => t.type === 'video')?.codec).toBe('vp9');
    expect(tracks.find(t => t.type === 'audio')?.codec).toBe('aac');
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, i) => value >= 0 && value <= 1 && (i === 0 || value >= progress[i - 1]))).toBe(true);
  });
  it('rejects swapped tracks instead of producing silent or audio-only output', async () => {
    expect(await remuxTracks(await fixture('audio'), await fixture('video')))
      .toEqual({ ok: false, error: 'invalid-tracks' });
  });
  it('returns a safe error for corrupt data', async () => {
    expect(await remuxTracks(new Blob(['NOT_MP4_SECRET_URL']), await fixture('audio')))
      .toEqual({ ok: false, error: 'invalid-media' });
  });
  it('rejects empty input', async () => {
    expect(await remuxTracks(new Blob(), await fixture('audio')))
      .toEqual({ ok: false, error: 'invalid-media' });
  });
  it('checks the memory budget before reading oversized blobs', async () => {
    const huge = new Blob();
    Object.defineProperty(huge, 'size', { value: 65 * 1024 * 1024 });
    expect(await remuxTracks(huge, await fixture('audio')))
      .toEqual({ ok: false, error: 'too-large' });
  });
  it('honors cancellation before opening either input', async () => {
    expect(await remuxTracks(await fixture('video'), await fixture('audio'), { signal: AbortSignal.abort() }))
      .toEqual({ ok: false, error: 'cancelled' });
  });
  it('cancels during packet processing and returns no partial output', async () => {
    const controller = new AbortController();
    const result = await remuxTracks(await fixture('video'), await fixture('audio'), {
      signal: controller.signal, onProgress: value => { if (value > 0) controller.abort(); },
    });
    expect(result).toEqual({ ok: false, error: 'cancelled' });
  });
});
