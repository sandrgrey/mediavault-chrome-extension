export type SaveControlProps = { message: string; busy: boolean; canCancel: boolean; redownload: boolean; save: () => void; cancel: () => void };
export function ReelSaveControl(props: SaveControlProps) {
  return <section aria-label="MediaVault">
    <strong>MediaVault</strong>
    <p>Для сохранения страница будет перезагружена</p>
    <button disabled={props.busy} onClick={event => { if (event.isTrusted) props.save(); }}>{props.redownload ? 'Скачать повторно' : 'Save Reel'}</button>
    {props.canCancel && <button onClick={event => { if (event.isTrusted) props.cancel(); }}>Отмена</button>}
    <p role="status" aria-live="polite">{props.message}</p>
  </section>;
}
