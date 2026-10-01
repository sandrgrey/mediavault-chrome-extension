import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture-listen-failed');
  return `http://127.0.0.1:${address.port}`;
}
export async function startFixtureServer() {
  const requests: { path: string; cookie: string | undefined; origin: string | undefined }[] = [];
  const media = createServer(async (req, res) => {
    requests.push({ path: req.url ?? '', cookie: req.headers.cookie, origin: req.headers.origin });
    if (req.url !== '/video.mp4' && req.url !== '/audio.mp4') { res.writeHead(404).end(); return; }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'video/mp4');
    res.end(await readFile(resolve('tests/fixtures/media', req.url.slice(1))));
  });
  const mediaOrigin = await listen(media);
  const page = createServer(async (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end((await readFile(resolve('tests/fixtures/transport/page.html'), 'utf8')).replaceAll('MEDIA_ORIGIN', mediaOrigin));
  });
  const pageOrigin = await listen(page);
  return { pageOrigin, mediaOrigin, requests, close: async () => {
    await Promise.all([page, media].map(server => new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done()); server.closeAllConnections();
    })));
  } };
}

