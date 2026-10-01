import { createRoot, type Root } from 'react-dom/client';
import { ReelSaveControl } from './ReelSaveControl';
import { createReelLifecycle } from './reelLifecycle';
import { reelIdentity } from '../providers/instagram/reelIdentity';
import { plain } from '../media/reelProtocol';

chrome.runtime.onMessage.addListener((input, sender, reply) => {
  if (sender.id === chrome.runtime.id && plain(input, ['version', 'type']) && input.version === 1 && input.type === 'reel-owner-probe') reply({ alive: true });
});

let mounted: { key: string; host: HTMLElement; root: Root; controller: ReturnType<typeof createReelLifecycle> } | null = null;
function reconcile() {
  if (!document.body) return;
  const identity = reelIdentity(location.href), key = identity.ok ? identity.value.publicationId : '';
  if (mounted && (mounted.key !== key || !mounted.host.isConnected)) {
    mounted.controller.dispose(); mounted.root.unmount(); mounted.host.remove(); mounted = null;
  }
  if (!key || mounted) return;
  const host = document.createElement('div');
  host.id = 'mediavault-save-control';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' }), style = document.createElement('style'), container = document.createElement('div');
  style.textContent = ':host{all:initial}section{font:13px/1.4 system-ui;color:#eee;background:#202126;border:1px solid #555;border-radius:12px;padding:14px;max-width:260px;box-shadow:0 4px 20px #0005}p{margin:8px 0}button{font:inherit;cursor:pointer;padding:7px 12px;border-radius:6px;border:0;margin-right:6px}button:disabled{opacity:.5;cursor:default}';
  shadow.append(style, container); document.body.append(host);
  const root = createRoot(container);
  const render = () => root.render(<ReelSaveControl {...controller.snapshot()} save={() => { void controller.save(); }} cancel={() => { void controller.cancel(); }} />);
  const controller = createReelLifecycle(render);
  mounted = { key, host, root, controller }; render();
}
let pending: ReturnType<typeof setTimeout> | undefined;
const schedule = () => { if (!pending) pending = setTimeout(() => { pending = undefined; reconcile(); }, 100); };
new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
setInterval(schedule, 500);
document.addEventListener('DOMContentLoaded', reconcile, { once: true });
reconcile();
