import { expect, it } from 'vitest';
import { reelIdentity } from '../../../src/providers/instagram/reelIdentity';
it.each(['reel', 'reels'])('canonicalizes %s route without query or fragment', route => {
  expect(reelIdentity(`https://www.instagram.com/${route}/Ab_123/?x=secret#fragment`)).toEqual({
    ok: true, value: { publicationId: 'instagram:Ab_123', sourceIdentity: 'Ab_123', sourceUrl: 'https://www.instagram.com/reel/Ab_123/' },
  });
});
it.each(['https://www.instagram.com/', 'https://www.instagram.com/user/', 'https://www.instagram.com/p/Ab/', 'https://user:pass@www.instagram.com/reel/Ab/', 'https://evil.example/reel/Ab/', 'not-url'])('rejects unsupported route %s', url => {
  expect(reelIdentity(url)).toEqual({ ok: false, error: 'unsupported-page' });
});

