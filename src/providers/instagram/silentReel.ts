// Only the observed explicit absence label is accepted; mute controls are not evidence.
export function isExplicitlySilent(video: HTMLVideoElement): boolean {
  for (let parent = video.parentElement, depth = 0; parent && depth < 12; parent = parent.parentElement, depth++) {
    if (parent === document.body || parent === document.documentElement) return false;
    if (parent.querySelectorAll('video').length !== 1) return false;
    const markers = parent.querySelectorAll('svg[aria-label="В видео нет звука"]');
    for (const marker of markers) {
      const r = marker.getBoundingClientRect();
      let visible = true;
      for (let element: Element | null = marker; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || style.opacity === '0') {
          visible = false; break;
        }
      }
      if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight &&
        visible) return true;
    }
  }
  return false;
}
