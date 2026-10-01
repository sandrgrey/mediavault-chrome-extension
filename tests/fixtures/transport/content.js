import { remuxTracks } from '../../../src/media/remux';

document.querySelector('#save').addEventListener('click', async () => {
  const status = document.querySelector('#status');
  status.textContent = 'fetching';
  let url;
  try {
    const base = document.body.dataset.mediaOrigin;
    const [video, audio] = await Promise.all(['video', 'audio'].map(async name => {
      const response = await fetch(`${base}/${name}.mp4`, { credentials: 'omit' });
      if (!response.ok) throw Error('fetch-failed');
      return response.blob();
    }));
    const result = await remuxTracks(video, audio);
    if (!result.ok) throw Error('remux-failed');
    url = URL.createObjectURL(result.value);
    if (document.body.dataset.closeBeforeDownload === 'true') {
      document.body.dataset.blob = url;
      status.textContent = 'ready';
      return;
    }
    status.textContent = 'downloading';
    const reply = await chrome.runtime.sendMessage({ type: 'save', url });
    if (reply?.state !== 'complete') throw Error('download-failed');
    URL.revokeObjectURL(url);
    url = undefined;
    status.textContent = 'complete; released';
  } catch {
    if (url) URL.revokeObjectURL(url);
    status.textContent = 'failed';
  }
});
