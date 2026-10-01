import { expect, it } from 'vitest';
import { mediaUrl, parseBridgeMessage } from '../../src/media/reelProtocol';
const activate = { version: 1, type: 'activate', session: { operationId: 'op', token: 'token', deadlineMs: 1000 } };
it('accepts only the complete supported activation contract', () => {
  expect(parseBridgeMessage(activate)).toEqual(activate);
  for (const input of [null, { ...activate, extra: true }, { ...activate, version: 2 }, { ...activate, type: 'fetch' },
    { ...activate, session: { ...activate.session, url: 'secret' } }, { ...activate, session: { ...activate.session, token: 'x'.repeat(201) } },
    Object.assign(Object.create({ attack: true }), activate)]) expect(parseBridgeMessage(input)).toBeNull();
});
it('validates CDN endpoints and removes only byte range parameters', () => {
  expect(mediaUrl('https://scontent-lax7-1.cdninstagram.com/a.mp4?bytestart=10&byteend=20&sig=x')?.href)
    .toBe('https://scontent-lax7-1.cdninstagram.com/a.mp4?sig=x');
  for (const url of ['http://scontent-lax7-1.cdninstagram.com/a.mp4', 'https://scontent-lax7-1.cdninstagram.com.evil/a.mp4',
    'https://user:pass@scontent-lax7-1.cdninstagram.com/a.mp4', 'https://unknown.cdninstagram.com/a.mp4', 'https://scontent-lax7-1.cdninstagram.com/a.html'])
    expect(mediaUrl(url)).toBeNull();
});

