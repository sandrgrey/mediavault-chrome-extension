import { useEffect, useRef, useState } from 'react';
import { downloadMergedBlob } from '../download/blobDownload';
import { remuxTracks, type RemuxError } from './remux';

const messages: Record<RemuxError | 'download-failed', string> = {
  'invalid-media': 'Не удалось прочитать MP4. Проверьте выбранные файлы.',
  'invalid-tracks': 'Нужны два отдельных MP4: один с видео, второй со звуком.',
  'unsupported-codec': 'Кодек этих дорожек не поддерживается в MP4.',
  'too-large': 'Файлы слишком большие или сложные. Общий размер — не более 64 МиБ.',
  'duration-mismatch': 'Время начала или длительность дорожек не совпадают.',
  'cancelled': 'Операция отменена.',
  'download-failed': 'Не удалось сохранить MP4. Проверьте загрузки Chrome.',
};

export function MergePage() {
  const [video, setVideo] = useState<File>();
  const [audio, setAudio] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('Выберите две дорожки одной записи.');
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (active.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); active.current?.abort(); };
  }, []);

  async function merge() {
    if (active.current || !video || !audio) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setError(''); setProgress(0); setStatus('Объединение дорожек…');
    try {
      const merged = await remuxTracks(video, audio, { signal: controller.signal, onProgress: setProgress });
      if (!merged.ok) {
        if (merged.error === 'cancelled') setStatus(messages.cancelled);
        else { setStatus(''); setError(messages[merged.error]); }
        return;
      }
      setStatus('Сохранение MP4…');
      const saved = await downloadMergedBlob(merged.value, controller.signal);
      if (saved.ok) setStatus('MP4 сохранён.');
      else if (saved.error === 'cancelled') setStatus(messages.cancelled);
      else { setStatus(''); setError(messages[saved.error]); }
    } catch { setStatus(''); setError('Не удалось завершить операцию. Попробуйте ещё раз.'); }
    finally { active.current = null; setBusy(false); }
  }

  return <main>
    <a href="library.html">← Библиотека MediaVault</a>
    <h1>Объединить видео и звук</h1>
    <p>Выберите отдельные дорожки MP4. Объединение выполняется на этом устройстве без перекодирования и потери качества.</p>
    <p>Общий размер — до 64 МиБ. Автоматическое получение дорожек из Instagram пока не подключено.</p>
    <fieldset disabled={busy}>
      <legend>Исходные файлы</legend>
      <label>Видеодорожка<input type="file" accept=".mp4,video/mp4" onChange={e => setVideo(e.target.files?.[0])} /></label>
      <label>Аудиодорожка<input type="file" accept=".mp4,.m4a,audio/mp4" onChange={e => setAudio(e.target.files?.[0])} /></label>
    </fieldset>
    <div className="actions">
      <button disabled={busy || !video || !audio} onClick={() => void merge()}>Объединить и сохранить</button>
      {busy && <button onClick={() => { active.current?.abort(); setStatus('Отмена…'); }}>Отмена</button>}
    </div>
    {busy && <><progress aria-label="Прогресс объединения" value={progress} max={1} /><p>Не закрывайте эту вкладку до окончания сохранения.</p></>}
    <p role="status">{status}</p>
    {error && <p role="alert">{error}</p>}
    <small>Результат: MediaVault/merged.mp4 в загрузках Chrome. При совпадении имени создаётся копия.</small>
  </main>;
}
