import {
  BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacketSink,
  EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output,
} from 'mediabunny';

export type RemuxError = 'invalid-media' | 'invalid-tracks' | 'unsupported-codec' | 'too-large' | 'duration-mismatch' | 'cancelled';
export type RemuxResult = { ok: true; value: Blob } | { ok: false; error: RemuxError };
export type RemuxOptions = { signal?: AbortSignal; onProgress?: (value: number) => void };

// Input files, packet copies and output coexist briefly. Bound input size rather than promise unlimited RAM.
export const MAX_REMUX_INPUT_BYTES = 64 * 1024 * 1024;
export async function remuxTracks(video: Blob, audio: Blob | null, options: RemuxOptions = {}): Promise<RemuxResult> {
  const fail = (error: RemuxError): RemuxResult => ({ ok: false, error });
  if (options.signal?.aborted) return fail('cancelled');
  const totalBytes = video.size + (audio?.size ?? 0);
  if (totalBytes > MAX_REMUX_INPUT_BYTES) return fail('too-large');
  if (!video.size || (audio !== null && !audio.size)) return fail('invalid-media');
  const inputs = (audio ? [video, audio] : [video]).map(blob => new Input({ source: new BlobSource(blob), formats: [MP4] }));
  let output: Output<Mp4OutputFormat, BufferTarget> | undefined;
  const checkAbort = () => { if (options.signal?.aborted) throw new Error('cancelled'); };
  try {
    const videoTrack = await inputs[0].getPrimaryVideoTrack();
    const audioTrack = audio ? await inputs[1].getPrimaryAudioTrack() : null;
    if (!videoTrack || (audio !== null && !audioTrack) || (await inputs[0].getTracks()).length !== 1 || (audio !== null && (await inputs[1].getTracks()).length !== 1))
      return fail('invalid-tracks');
    const [videoCodec, audioCodec, videoConfig, audioConfig] = await Promise.all([
      videoTrack.getCodec(), audioTrack?.getCodec(), videoTrack.getDecoderConfig(), audioTrack?.getDecoderConfig(),
    ]);
    const format = new Mp4OutputFormat({ fastStart: 'in-memory' });
    if (!videoCodec || !videoConfig || (audio !== null && (!audioCodec || !audioConfig)) ||
      !format.getSupportedVideoCodecs().includes(videoCodec) || (audioCodec != null && !format.getSupportedAudioCodecs().includes(audioCodec)))
      return fail('unsupported-codec');
    const [videoEnd, audioEnd, videoStart, audioStart] = await Promise.all([
      videoTrack.computeDuration(), audioTrack?.computeDuration() ?? videoTrack.computeDuration(), videoTrack.getFirstTimestamp(), audioTrack?.getFirstTimestamp() ?? videoTrack.getFirstTimestamp(),
    ]);
    if (![videoEnd, audioEnd, videoStart, audioStart].every(Number.isFinite) || videoEnd <= videoStart || audioEnd <= audioStart)
      return fail('invalid-media');
    // Allow normal AAC priming/frame rounding, but never silently join unrelated timelines.
    if (Math.abs(videoStart - audioStart) > 0.25 || Math.abs(videoEnd - audioEnd) > 0.25)
      return fail('duration-mismatch');
    checkAbort();
    output = new Output({ format, target: new BufferTarget() });
    const videoSource = new EncodedVideoPacketSource(videoCodec);
    const audioSource = audioCodec ? new EncodedAudioPacketSource(audioCodec) : null;
    output.addVideoTrack(videoSource, { transformationMatrix: await videoTrack.getTransformationMatrix() });
    if (audioSource) output.addAudioTrack(audioSource);
    // Do not copy source metadata tags, URLs or filenames into the result.
    await output.start();
    const videoPackets = new EncodedPacketSink(videoTrack).packets();
    const audioPackets = audioTrack ? new EncodedPacketSink(audioTrack).packets() : (async function* () {})();
    let nextVideo = await videoPackets.next(), nextAudio = await audioPackets.next();
    let copied = 0, packets = 0, videoCount = 0, audioCount = 0;
    try {
      while (!nextVideo.done || !nextAudio.done) {
        checkAbort();
        if (!nextVideo.done && (nextAudio.done || nextVideo.value.timestamp <= nextAudio.value.timestamp)) {
          await videoSource.add(nextVideo.value, { decoderConfig: videoConfig });
          copied += nextVideo.value.data.byteLength;
          videoCount++;
          nextVideo = await videoPackets.next();
        } else if (!nextAudio.done) {
          await audioSource!.add(nextAudio.value, { decoderConfig: audioConfig! });
          copied += nextAudio.value.data.byteLength;
          audioCount++;
          nextAudio = await audioPackets.next();
        }
        if (copied > MAX_REMUX_INPUT_BYTES || ++packets > 100_000) return fail('too-large');
        options.onProgress?.(Math.min(0.95, copied / totalBytes * 0.95));
        // Let the page render progress and process cancellation between batches.
        if (packets % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally {
      await videoPackets.return();
      await audioPackets.return();
    }
    checkAbort();
    if (!videoCount || (audio !== null && !audioCount)) return fail('invalid-media');
    videoSource.close(); audioSource?.close();
    await output.finalize();
    checkAbort();
    if (!output.target.buffer) return fail('invalid-media');
    const value = new Blob([output.target.buffer], { type: 'video/mp4' });
    options.onProgress?.(1);
    checkAbort();
    return { ok: true, value };
  } catch {
    return fail(options.signal?.aborted ? 'cancelled' : 'invalid-media');
  } finally {
    inputs.forEach(input => input.dispose());
    if (output && output.state !== 'finalized') await output.cancel().catch(() => undefined);
  }
}
