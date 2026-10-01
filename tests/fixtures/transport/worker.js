chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type !== 'save') return;
  void (async () => {
    try {
      const id = await chrome.downloads.download({ url: message.url, filename: 'MediaVault/transport.mp4', conflictAction: 'uniquify' });
      for (let attempt = 0; attempt < 100; attempt++) {
        const [item] = await chrome.downloads.search({ id });
        if (item?.state === 'complete' || item?.state === 'interrupted') { reply({ state: item.state }); return; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      reply({ state: 'timeout' });
    } catch { reply({ state: 'failed' }); }
  })();
  return true;
});
