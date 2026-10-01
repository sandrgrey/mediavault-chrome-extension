# Synthetic remux fixtures

Generated locally with FFmpeg, no Instagram content or metadata.

`video.mp4`: 1-second 64x64 testsrc2 at 12 fps, VP9, fragmented MP4.
`audio.mp4`: 1-second 440 Hz sine, 44100 Hz stereo AAC, fragmented MP4.

FFmpeg is used only to generate fixtures and independently verify outputs, never by the extension.

`video-mse.mp4` and `audio-mse.mp4` are packet-copy variants made with
`-c copy -movflags +frag_keyframe+empty_moov+default_base_moof` for browser MSE.
Both SourceBuffers are created before appending either initialization segment.
