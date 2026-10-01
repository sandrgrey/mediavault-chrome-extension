# MediaVault Chrome Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Способ исполнения выбирается перед началом реализации; этот документ не запускает разработку.

**Goal:** Расширение Chrome сохраняет одну открытую публикацию Instagram, автоматически обходит карусель и ведёт локальную библиотеку с ручной докачкой и повторным скачиванием.

**Architecture:** Content script управляет кнопкой и обходом страницы через изолированный Instagram-адаптер. Service worker проверяет сообщения, резервирует операции, запускает Chrome Downloads и атомарно обновляет библиотеку и служебный журнал IndexedDB. Страница React читает библиотеку и открывает источник для действий, требующих свежих адресов медиа.

**Tech Stack:** TypeScript, React, Vite, Manifest V3, IndexedDB через `idb`, Vitest, Testing Library, Playwright, ESLint, GitHub Actions. Конкретные совместимые версии фиксируются lockfile при выполнении задачи 1.

**Spec:** [Исходная спецификация](https://github.com/sandrgrey/mediavault-chrome-extension/blob/f14ec5673a0e65af853e9ac195f51dcf56954a19/docs/superpowers/specs/2026-09-29-chrome-extension-design.md) и [дополнение к дизайну](../specs/2026-10-01-chrome-extension-addendum.md). При расхождении сценариев приоритет у дополнения.

Дата: 1 октября 2026 года. План заменяет [редакцию от 29 сентября](https://github.com/sandrgrey/mediavault-chrome-extension/blob/f14ec5673a0e65af853e9ac195f51dcf56954a19/docs/superpowers/plans/2026-09-29-chrome-extension.md). Проверенный исходный commit: `f14ec5673a0e65af853e9ac195f51dcf56954a19`; в нём только спецификация и план. Все задачи ниже пока не выполнены. Это локальный документ, публикация на GitHub не выполнена.

## Global Constraints

- Только desktop Chrome / Manifest V3, одна явно открытая публикация: photo, video, reel или carousel.
- Save сразу запускает операцию по нажатию пользователя; отдельного предпросмотра нет. Открытие источника из библиотеки само по себе ничего не скачивает.
- Режимы `save`, `retry`, `redownload` различаются. Обычный Save не дублирует завершённое. Retry получает свежий состав на странице. Redownload намеренно скачивает всю публикацию, не перезаписывая файлы.
- Автоматического отслеживания удалённых файлов нет. «Скачано» означает завершение в прошлом. Удаление записи библиотеки не удаляет файлы с диска.
- Карусель собирается по порядку; полный успех допустим только при подтверждённой полноте и успешном завершении всех элементов.
- Пределы: `MAX_ITEMS=50`, `SLIDE_TIMEOUT_MS=10_000`, `COLLECTION_TIMEOUT_MS=120_000`. Общий тайм-аут включает движение к первому слайду. Это внутренние ограничения, не характеристики Instagram.
- «Отмена» и уход с публикации прекращают сбор и запуск новых загрузок. Уже запущенные Chrome загрузки могут завершиться и учитываются.
- В библиотеке разрешены автор, подпись, канонический источник, тип, даты, статусы, имена и необязательная миниатюра. Миниатюра первой версии — `null`, интерфейс показывает локальную заглушку.
- В собственной базе, журнале операций и логах запрещены cookies, токены, заголовки авторизации, временные/подписанные медиа-URL и HTML. Автор, подпись и исходный URL также запрещены в логах. Внутренняя история Chrome Downloads не входит в эту гарантию.
- Только `downloads`, `storage` и необходимый доступ к `https://www.instagram.com/*`. Нет `cookies`, `history`, clipboard, `debugger`, `<all_urls>` или недоказанной необходимости доступа к CDN.
- Нет обхода входа, ограничений доступа, challenges или rate limits. Нет фонового сбора профилей/лент, сервера, синхронизации и публикации в Chrome Web Store в этом плане.
- Автотесты используют только синтетические страницы и локальные медиа. Ручные проверки — контент, который тестировщику разрешено скачивать. Реальные страницы, идентификаторы аккаунтов, URLs и секреты в репозиторий не попадают.
- Все исходники и зависимости входят в сборку; удалённого исполняемого кода нет. Чистая установка должна давать unpacked `dist/` и ZIP из CI.

## Review Focus

1. После редактирования карусели старый индекс не доказывает идентичность: проверка устойчивых ключей, отказ от угадывания при retry — задачи 2, 5, 7.
2. Остановка worker между запуском файла и сохранением downloadId оставляет неопределённость: никакого автоматического повторения — задачи 4, 7, 9.
3. Две вкладки или повторная доставка сообщения не должны запускать копии: атомарная резервация и идемпотентность запросов — задачи 4, 7, 9.
4. Подмена отправителя, страницы или медиа-адреса не должна запускать загрузку: проверка по типу команды и данным операции — задача 7.
5. Ошибка IndexedDB после завершения файла и неудачный redownload не должны уничтожить предыдущий успех: атомарная проекция и восстановление — задачи 4, 7, 9.

## Структура файлов

Все пути ниже относительны корню будущего checkout репозитория. Файлы Create отсутствуют в исходном commit; Modify относятся к файлам, созданным предыдущими задачами.

```text
docs/FEASIBILITY.md, INSTALL.md, PRIVACY.md, ACCEPTANCE.md
public/manifest.json, icons/icon-16.png, icons/icon-48.png, icons/icon-128.png
library.html
vite.config.ts, vite.content.config.ts, vitest.config.ts, playwright.config.ts
scripts/build.mjs, package-extension.mjs
src/domain/models.ts, persistence.ts, selectItems.ts
src/shared/result.ts, messages.ts
src/storage/database.ts, operations.ts
src/download/filenames.ts, chromeDownloads.ts
src/background/main.ts, saveCoordinator.ts, recovery.ts, sourceActions.ts
src/providers/instagram/classifyPage.ts, selectors.ts, adapter.ts, carousel.ts
src/content/main.tsx, SaveControl.tsx, mountSaveControl.tsx, navigationObserver.ts, content.css
src/library/main.tsx, App.tsx, filters.ts, repository.ts, styles.css
tests/setup.ts, helpers/domain.ts
tests/scaffold/, domain/, download/, storage/, providers/instagram/, content/
tests/shared/, background/, library/, privacy/, integration/, fixtures/instagram/
.github/workflows/ci.yml
```

## Общие контракты

Задача 2 определяет типы; задачи 4 и 7 реализуют переходы. `Result<T>` — `{ok:true,value:T}` или `{ok:false,error:MediaVaultErrorCode}`. Все даты — UTC ISO strings, время для тайм-аутов передаётся как `nowMs:number`. Provider — `instagram`; `PublicationKind` — `photo|video|reel|carousel`.

```ts
type SaveMode = 'save' | 'retry' | 'redownload';
type CollectionStatus = 'complete' | 'partial';
type ItemState = 'pending' | 'dispatching' | 'downloading' |
  'completed' | 'failed' | 'cancelled' | 'uncertain';
type OperationState = 'collecting' | 'downloading' | 'stopping' |
  'completed' | 'partial' | 'failed' | 'cancelled' | 'needs-user' | 'uncertain';
type SourceIntent = { publicationId: string; mode: 'view' | 'retry' | 'redownload' };
type Owner = { tabId: number; documentId: string };
type ResolvedMediaItem = {
  index: number; stableItemId: string | null;
  mediaType: 'image' | 'video'; extension: 'jpg' | 'png' | 'webp' | 'mp4';
  downloadUrl: string;
};
type PublicationMetadata = {
  id: string; provider: 'instagram'; sourceIdentity: string; sourceUrl: string;
  author: string | null; caption: string | null; kind: PublicationKind;
};
type ResolvedPublication = PublicationMetadata & {
  collectionStatus: CollectionStatus; expectedCount: number | null;
  items: ResolvedMediaItem[];
};
type MediaItemRecord = Omit<ResolvedMediaItem, 'downloadUrl' | 'extension'> & {
  filename: string; downloadId: number | null;
  status: 'completed' | 'failed'; errorCode: MediaVaultErrorCode | null;
};
type PublicationRecord = PublicationMetadata & {
  savedAt: string; updatedAt: string; thumbnail: Blob | null;
  collectionStatus: CollectionStatus; expectedCount: number | null;
  items: MediaItemRecord[];
};
type OperationItem = Omit<MediaItemRecord, 'status'> & { status: ItemState };
type OperationRecord = {
  id: string; requestId: string; publicationId: string; mode: SaveMode;
  owner: Owner; state: OperationState; collectDeadlineMs: number;
  metadata: PublicationMetadata | null; collectionStatus: CollectionStatus;
  expectedCount: number | null; items: OperationItem[];
  cancelRequested: boolean; createdAt: string; updatedAt: string;
};
type BeginInput = {
  requestId: string; publicationId: string; mode: SaveMode; owner: Owner; nowMs: number;
};
type BeginOutcome = { kind: 'accepted'; operationId: string } |
  { kind: 'already-saved' | 'busy' | 'retry-required' | 'needs-review' };
type SubmitInput = { operationId: string; publication: ResolvedPublication; owner: Owner };
type CollectionProgress = { found: number; expected: number | null };
type OperationView = Pick<OperationRecord, 'id' | 'publicationId' | 'state' | 'mode'> & {
  found: number; expected: number | null; completed: number; failed: number;
};
```

Ошибки: исходные `unsupported-page`, `login-required`, `media-not-found`, `unavailable`, `download-failed`, `partial-carousel`, `storage-failed`, `extension-updated`; дополнительные `storage-empty-record`, `invalid-message`, `collection-incomplete`, `collection-timeout`, `too-many-items`, `cancelled`, `publication-changed`, `identity-unavailable`, `source-changed`, `operation-expired`, `needs-review`. Тексты сырых ошибок Chrome не сохранять и не логировать.

## Task 0: Проверить основной риск до разработки интерфейса

**Files:** Create `docs/FEASIBILITY.md`; временные пробы — только `work/`, вне production bundle.

**Interfaces:** вход — разрешённые photo/video/reel/carousel на настоящем Instagram; выход — таблица PASS/FAIL по извлечению, полноте карусели, устойчивым идентификаторам, прямой загрузке и минимальным permissions.

- [ ] Проверить получение пригодного адреса файла, начало/конец карусели, порядок, lazy loading и наличие устойчивых идентификаторов. Отдельно проверить случай `blob:`/потокового видео: наличие video-элемента не считается успехом.
- [ ] Повторить сбор той же публикации после обновления страницы и после изменения тестовой карусели; записать только выводы, без самих адресов/идентификаторов/HTML.
- [ ] Проверить скачивание через Chrome Downloads с минимальными permissions. Не добавлять CDN permissions без воспроизводимого доказательства необходимости.
- [ ] Записать дату, версии браузера, типы контента, результаты и ограничения. Если обязательный формат недоступен — остановить зависимую реализацию адаптера и обозначить конкретное препятствие; не выдавать фикстуры за реальную совместимость.
- [ ] Commit: `docs: record Instagram extraction feasibility`.

## Task 1: Воспроизводимая сборка расширения

**Files:** Create `package.json`, `package-lock.json`, `.gitignore`, `tsconfig.json`, `eslint.config.js`, `vite.config.ts`, `vite.content.config.ts`, `vitest.config.ts`, `scripts/build.mjs`, `public/manifest.json`, `public/icons/icon-16.png`, `public/icons/icon-48.png`, `public/icons/icon-128.png`, `library.html`, `src/background/main.ts`, `src/content/main.tsx`, `src/library/main.tsx`, `src/library/App.tsx`, `tests/setup.ts`, `tests/scaffold/manifest.test.ts`, `tests/scaffold/build.test.ts`.

**Interfaces:** команды `build`, `test`, `test:run`, `lint`, `typecheck`; результат `dist/manifest.json`, `dist/background.js`, `dist/content.js`, `dist/library.html` и локальные assets.

- [ ] Создать package metadata и тестовый runner; установить совместимые версии перечисленного стека, `fake-indexeddb`, Chrome/React types и сохранить lockfile.
- [ ] Написать RED: manifest version равен 3; host match ровно `https://www.instagram.com/*`; permissions ровно `downloads`, `storage`; ссылки manifest ведут на существующие JS/assets, а не `src/*.ts`; собранный content script парсится как обычный script без внешних импортов.
- [ ] Выполнить `npm run test:run -- tests/scaffold`; ожидать падение по отсутствующим manifest/build artifacts, а не из-за неустановленного runner.
- [ ] Реализовать две последовательные сборки: библиотека и module worker; отдельно один полностью включающий зависимости IIFE content script. Второй проход не очищает результаты первого. Manifest указывает `background.js` с type module и `content.js`. React/CSS content control не требуют глобальных объектов страницы.
- [ ] GREEN: `npm run build`, затем `npm run test:run -- tests/scaffold`, `npm run typecheck`, `npm run lint`. Загрузить dist в тестовый Chrome: нет ошибок синтаксиса/import/CSP. Commit: `build: scaffold runnable Manifest V3 extension`.

## Task 2: Контракты, проекции и выбор элементов

**Files:** Create `src/domain/models.ts`, `src/domain/persistence.ts`, `src/domain/selectItems.ts`, `src/shared/result.ts`, `tests/helpers/domain.ts`, `tests/domain/persistence.test.ts`, `tests/domain/selectItems.test.ts`.

**Interfaces:** типы раздела «Общие контракты»; `selectItems(mode:SaveMode, resolved:ResolvedPublication, previous:PublicationRecord|null):Result<ResolvedMediaItem[]>`; `toPublicationRecord(operation:OperationRecord, previous:PublicationRecord|null, now:string):Result<PublicationRecord>`.

- [ ] Написать RED для режимов и проекции. Создать синтетические factories в `tests/helpers/domain.ts`. Сценарий: из элементов `a,b,c` ранее завершены `a,c`; retry выбирает только `b`; redownload выбирает все три. При отсутствии устойчивых ключей для retry — `identity-unavailable`, при изменении набора/порядка ключей — `source-changed`.

```ts
expect(retryItems.map(x => x.stableItemId)).toEqual(['b']);
expect(redownloadItems).toHaveLength(3);
expect(projectWithoutAnySuccess).toEqual({ ok: false, error: 'storage-empty-record' });
expect(projectFailedRedownload.value.items[0].status).toBe('completed');
```

- [ ] RED: `npm run test:run -- tests/domain` — отсутствующие функции либо неверные перечисленные результаты.
- [ ] Реализовать только явные разрешённые поля. Не использовать spread transient объектов для записи. Для полного прежнего состава retry требует совпадения упорядоченного списка устойчивых ключей; для частично собранного — все известные ключи должны присутствовать в прежнем относительном порядке. Новые ключи допускаются только при прежней неполноте; при неоднозначности отказ.
- [ ] Индекс без ключа допустим для первого Save и redownload, но не доказывает соответствие при retry. Не сопоставлять изменившиеся наборы redownload со старой записью по индексам: предыдущий успешный снимок сохранять до полного успеха нового состава; частичную новую попытку показывать через OperationView.
- [ ] GREEN: `npm run test:run -- tests/domain`, `npm run typecheck`. Проверить рекурсивное отсутствие запретных ключей и контрольных URL в проекциях; прежние savedAt и успех не теряются. Commit: `feat: define save modes and privacy-safe records`.

## Task 3: Безопасные имена и ключи

**Files:** Create `src/download/filenames.ts`, `tests/download/filenames.test.ts`.

**Interfaces:** `sanitizePathSegment(value:string,fallback:string):string`; `publicationKey(sourceUrl:string):Result<string>`; `mediaItemKey(publicationId:string,item:ResolvedMediaItem):string`; `buildDownloadPath(publication:PublicationMetadata,item:ResolvedMediaItem):string`.

- [ ] Написать RED: папка `MediaVault/instagram/<safe-author>/<publication-id>/`, номера от `01`, сохранение подтверждённого расширения. Проверить `../`, `CON`, `NUL.txt`, Unicode-пробелы, управляющие символы, слеши и длину более 120 символов.

```ts
expect(sanitizePathSegment('CON', 'unknown')).toBe('_CON');
expect(sanitizePathSegment('\u2003', 'unknown-author')).toBe('unknown-author');
expect(Array.from(sanitizePathSegment('a'.repeat(121), 'x'))).toHaveLength(80);
```

- [ ] RED: `npm run test:run -- tests/download/filenames.test.ts`.
- [ ] Реализовать сегменты до 80 Unicode code points, замену недопустимых символов, удаление конечных точек/пробелов и защиту reserved names. Canonical source без query/fragment. Для publication identity нормализовать одинаковый shortcode между поддерживаемыми маршрутами. Item key использует устойчивый ID; при его отсутствии индекс относится только к текущему снимку.
- [ ] GREEN: тот же тест и `npm run typecheck`. Commit: `feat: add safe ordered download paths`.

## Task 4: Библиотека и атомарный журнал операций

**Files:** Create `src/storage/database.ts`, `src/storage/operations.ts`, `src/library/repository.ts`, `tests/storage/operations.test.ts`, `tests/library/repository.test.ts`.

**Interfaces:** `openMediaVaultDatabase()` открывает `mediavault`, schema version 1; stores `publications`, `operations`, `activePublications`, `sourceIntents`. `LibraryRepository`: `get(id)`, `list()`, `remove(id)` возвращают Promise; запись библиотеки принадлежит журналу. `OperationRepository`: `begin(input:BeginInput):Promise<Result<BeginOutcome>>`, `get(id):Promise<OperationRecord|null>`, `findRecoverable():Promise<OperationRecord[]>`, `attachCollection(input:SubmitInput):Promise<Result<void>>`, `transitionItem(operationId,index,from:ItemState,to:ItemState,patch:Partial<Pick<OperationItem,'downloadId'|'errorCode'|'filename'>>):Promise<Result<void>>`, `requestCancel(id):Promise<Result<void>>`, `settle(id,state:OperationState,now:string):Promise<Result<void>>`.

- [ ] Написать RED: CRUD/search ordering; два одновременных begin одной публикации дают accepted/busy; один requestId возвращает прежнюю operation без второй записи; неожиданный from не меняет item; отказ transaction оставляет прежнюю библиотеку целой.

```ts
expect(beginResults.map(x => x.value.kind).sort()).toEqual(['accepted', 'busy']);
expect(await publicationsAfterFailedTransaction()).toEqual(previousRecords);
expect(await recordsAfterTotalFailure()).toHaveLength(0);
```

- [ ] RED: `npm run test:run -- tests/storage tests/library/repository.test.ts`.
- [ ] Создать stores и indices: publications по `sourceIdentity`, `savedAt`; operations по уникальному `requestId`, `publicationId`, `state`; activePublications primary key `publicationId`. begin, сравнение переходов и соответствующая проекция в библиотеку выполняются одной IDB-транзакцией; сетевые/Chrome вызовы внутри неё запрещены.
- [ ] В collecting задать `collectDeadlineMs = nowMs + 150_000`: 120 секунд сбора плюс доставка. Просроченный submit отклоняется без downloads. Начало Save для полной записи возвращает already-saved; для частичной — retry-required. Незавершённая загрузка удерживает резервацию; terminal освобождает её. Uncertain блокирует обычный Save, требует явного redownload после проверки известных активных downloadId. Повтор requestId остаётся идемпотентным и после завершения.
- [ ] Сохранить очищенные metadata и состав до первого Chrome-вызова. Завершение элемента и проекцию публикации записывать атомарно. Удаление библиотечной записи при активной операции возвращает busy. При разрешённом удалении той же транзакцией удалить связанные terminal operations и sourceIntents; запоздалые события неизвестных IDs игнорируются и не восстанавливают историю. Добавить тест события после удаления.
- [ ] GREEN: оба набора тестов, typecheck; отдельно upgrade пустой БД и quota/abort. Commit: `feat: persist atomic operations and library results`.

## Task 5: Instagram-адаптер и ограниченный обход карусели

**Files:** Create `src/providers/instagram/classifyPage.ts`, `selectors.ts`, `adapter.ts`, `carousel.ts` в той же папке; `tests/providers/instagram/adapter.test.ts`, `carousel.test.ts`; fixtures `photo.html`, `video.html`, `reel.html`, `carousel.html`, `login.html`, `unsupported.html`, `incomplete-carousel.html` в `tests/fixtures/instagram/`.

**Interfaces:** `classifyInstagramPage(document:Document,location:URL):Result<PublicationMetadata>`; `collectActivePublication(options:{document:Document;location:URL;signal:AbortSignal;onProgress:(p:CollectionProgress)=>void}):Promise<Result<ResolvedPublication>>`. Все DOM selectors и evidence правила находятся только в provider-модуле; доказательства берутся из задачи 0.

- [ ] Написать RED: все четыре вида, null optional metadata, канонический URL, video с непригодным источником, login/unsupported, последовательность с 3 слайдами и стартом со второго. Полный обход выдаёт `[0,1,2]`; повторные DOM-мутации не дублируют слайд; отсутствие Next без доказательства конца даёт partial.

```ts
expect(collected.items.map(x => x.index)).toEqual([0, 1, 2]);
expect(unconfirmedEnd.collectionStatus).toBe('partial');
expect(progressWithoutTotal.expected).toBeNull();
```

- [ ] RED: `npm run test:run -- tests/providers/instagram`.
- [ ] Реализовать движение к началу, затем вперёд, с AbortSignal, пределами 50/10_000/120_000 и фиксацией publication identity. Различать подтверждённое отсутствие следующего элемента и ещё не загрузившийся DOM. Ручное вмешательство, смена маршрута и abort останавливают цикл. Не сканировать/сериализовать весь документ.
- [ ] Timeout/limit после найденных элементов возвращает частичный состав; до первого — типизированную ошибку. Пользовательская отмена не запускает скачивание собранного. Unsupported scheme, неизвестный формат или недоступный поток не переименовывается искусственно в mp4/jpg.
- [ ] GREEN: тесты с fake timers на точных границах, typecheck; повторить ручную проверку задачи 0 уже production adapter. Commit: `feat: collect ordered Instagram carousels with cancellation`.

## Task 6: Кнопка, маршрутизация и остановка

**Files:** Create `src/content/SaveControl.tsx`, `mountSaveControl.tsx`, `navigationObserver.ts`, `content.css`, `tests/content/saveControl.test.tsx`, `navigationObserver.test.ts`; Modify `src/content/main.tsx`.

**Interfaces:** `mountSaveControl(target:Element,actions:ControlActions):{unmount():void}`; `startNavigationObserver(onChange:()=>void):()=>void`. `ControlActions` в SaveControl: `start(mode:SaveMode):Promise<void>`, `cancel():Promise<void>`, `subscribe(listener:(view:OperationView)=>void):()=>void`; задача 7 подключает реализацию.

- [ ] RED: один click → один start; во время операции повтор запрещён; distinct Save/Докачать/Скачать повторно; unknown count без процентов; «Отмена» вызывает cancel; Shadow DOM не зависит от стилей сайта.
- [ ] RED lifecycle: 20 мутаций за 100 ms → одна reconciliation; повторный mount → одна кнопка; смена публикации удаляет старую и отменяет её сбор; login/unsupported → ноль кнопок. `npm run test:run -- tests/content` должен падать на этих условиях до реализации.
- [ ] Реализовать debounce 100 ms и observation ограниченного корня; маршрут плюс identity определяют контекст. При уходе abort collection и запросить cancel операции; при размонтировании убрать observers/subscriptions. Не извлекать медиа в observer до клика.
- [ ] Для источника из библиотеки показывать выбранный режим, но не вызывать start. Восстановленный OperationView отображать после повторного открытия; длинное сохранение не держится на единственном Promise runtime-сообщения.
- [ ] GREEN: `npm run test:run -- tests/content`, typecheck. Commit: `feat: add save progress and explicit retry controls`.

## Task 7: Проверенные команды, загрузки и восстановление

**Files:** Create `src/shared/messages.ts`, `src/download/chromeDownloads.ts`, `src/background/saveCoordinator.ts`, `recovery.ts`, `sourceActions.ts` в background; tests `tests/shared/messages.test.ts`, `tests/background/saveCoordinator.test.ts`, `recovery.test.ts`, `sourceActions.test.ts`; Modify `src/background/main.ts`, `src/content/main.tsx`.

**Interfaces:** `SaveCoordinator.begin(input:BeginInput):Promise<Result<BeginOutcome>>`, `submit(input:SubmitInput):Promise<Result<{operationId:string}>>`, `cancel(operationId:string,owner:Owner):Promise<Result<void>>`, `getView(operationId:string):Promise<Result<OperationView>>`; `recoverOperations():Promise<void>`; `openSource(intent:SourceIntent):Promise<Result<void>>`; `validateRuntimeMessage(raw:unknown,sender:chrome.runtime.MessageSender):Result<RuntimeMessage>`.

`RuntimeMessage` — версия 1 и discriminant `begin|submit|cancel|status|open-source|read-intent`; payload содержит только параметры соответствующего метода. Owner берётся из sender, не из payload. `DownloadsPort`: `start(url:string,filename:string):Promise<number>`, `get(id:number):Promise<{id:number;state:'in_progress'|'complete'|'interrupted';filename:string;errorCode:MediaVaultErrorCode|null}|null>`, `onChange(listener:(id:number)=>void):()=>void`. Wrapper сразу отбрасывает url/finalUrl и другие ненужные DownloadItem fields.

- [ ] RED сообщений: неизвестная версия/команда, лишние свойства, prototype-bearing объекты, неверный source identity, отрицательные/повторные indices, >50 элементов, HTTP/data/blob URL, чужая операция, несоответствующий sender → ноль downloads и записей. Допустимые CDN hosts фиксируются только по задаче 0; просто HTTPS недостаточно. Это список допустимых адресов, не дополнительное host permission.
- [ ] RED orchestration: begin → сбор → submit; успех учитывается только при complete; все ошибки не создают новую library record; смешанный результат сохраняет успех; повтор submit не стартует копии; retry без fresh resolved данных невозможен; redownload использует uniquify и не затирает прежний успех.
- [ ] RED восстановления: убить worker после dispatching до сохранения ID; после сохранения ID до completion; после completion до записи результата. Ожидать соответственно uncertain/needs-review, восстановление по ID, восстановление успешной записи без нового start. Очищенная история → uncertain. Просроченный collecting без download → needs-user.
- [ ] RED: `npm run test:run -- tests/shared tests/background tests/storage tests/content`.
- [ ] Проверить `sender.id`, top frame, HTTPS `www.instagram.com`, поддерживаемый путь, shortcode и owner operation. Library-only команды принимаются только от точного `chrome.runtime.getURL('library.html')`. Источник для open-source берётся из repository, не из произвольного URL запроса. read-intent разрешён только соответствующей вкладке и публикации.
- [ ] Для режима view просто открыть источник без intent. Для retry/redownload сохранить intent в `sourceIntents` по tabId с временем жизни 10 минут; после перезапуска он лишь предлагает режим. Обработать гонку чтения до установки intent: worker после записи уведомляет готовый content script; поздно загрузившийся content script читает intent сам. Устаревший/чужой intent игнорируется, на закрытии вкладки удаляется. Источник открывается без скачивания; action click открывает library.html.
- [ ] Перед сбором вызвать begin; submit принимает только текущего владельца, неистёкшую резервацию и валидный состав. Применить selectItems. Downloads запускаются последовательно, не более одного активного файла на операцию: dispatching → вызов start с conflictAction uniquify → сохранение ID → проверка состояния. После каждого complete/interrupted разрешён переход к следующему только при живом исходном контексте, отсутствии cancel и наличии URL в памяти. Любая ошибка записи при запуске останавливает дальнейшую отправку.
- [ ] Cancellation фиксируется в IDB, удаляет неотправленные URL из памяти. Закрытие вкладки отслеживается через tabs.onRemoved; уход с публикации — через content lifecycle и проверку текущего маршрута перед следующим start. Уже запущенные файлы доучитываются. Listener completion сверяет текущее состояние по ID, поэтому ранние/повторные события не теряются и не удваивают результат. Перед ручным supersede неопределённой операции сверить все её известные downloadId: при in_progress вернуть busy; старую операцию после supersede исключить из записи библиотечного снимка. Добавить тест позднего события старой операции после начала redownload.
- [ ] Регистрировать listeners синхронно на верхнем уровне. При каждом пробуждении вызывать один идемпотентный recovery: сверить известные IDs, проецировать успех, неопределённые dispatching оставить uncertain. Активный collecting с действующим deadline не отменять только из-за перезапуска worker. Без URL в памяти не запускать оставшиеся файлы автоматически; после завершения известных downloads перевести в needs-user и разрешить ручную докачку.
- [ ] GREEN: предыдущие наборы, `npm run typecheck`, `npm run build`. Commit: `feat: coordinate recoverable user-initiated downloads`.

## Task 8: Библиотека и явные действия

**Files:** Create `src/library/filters.ts`, `styles.css`, `tests/library/filters.test.ts`, `App.test.tsx`; Modify `src/library/App.tsx`, `main.tsx`.

**Interfaces:** `filterRecords(records:PublicationRecord[],query:string,kind:PublicationKind|'all'):PublicationRecord[]`; зависимости UI — LibraryRepository, openSource и OperationView. Прямых Downloads start из страницы нет.

- [ ] RED: loading/empty/error, карточки/заглушки, author/caption search без учёта регистра, виды и сортировка savedAt descending; исходный массив не меняется. «Открыть для докачки» передаёт retry, «Скачать повторно» — redownload; при обоих число start downloads равно нулю.
- [ ] RED: удаление требует текста «Файлы останутся на диске» и не вызывает downloads.removeFile/erase. Для активной операции удаление недоступно. Для redownload видно «Если файлы сохранились, появятся копии». Последняя неудачная попытка отображается отдельно от прежнего успеха.
- [ ] RED: `npm run test:run -- tests/library`.
- [ ] Реализовать сетку, поиск/фильтры, source open, `chrome.downloads.showDefaultFolder`, историю и прогресс операции. Не опрашивать exists и не обещать текущее наличие файла. Частичный состав без известного total обозначать словами, не как полностью сохранённый.
- [ ] GREEN: library tests, typecheck, build; проверить широкую и узкую страницу 390 px. Commit: `feat: add local library with explicit source actions`.

## Task 9: Browser integration и privacy regression

**Files:** Create `playwright.config.ts`, `tests/integration/fixtureServer.ts`, `extension.spec.ts`, `workerRecovery.spec.ts`, `tests/privacy/noSensitivePersistence.test.ts`; Modify `package.json`, `package-lock.json`, `scripts/build.mjs`.

**Interfaces:** `npm run build:test-extension` → отдельный `dist-test/`; `npm run test:integration` загружает его в persistent Chromium context. `dist/` остаётся production. Успешность synthetic suite не означает совместимость Instagram.

- [ ] RED: реальный content script → runtime message → worker → IDB на синтетических страницах; одна кнопка после SPA-перехода, двойной click/две вкладки, partial carousel, retry/redownload, уход и отмена. Проверить запуск хотя бы одной настоящей локальной загрузки; одних моков Downloads API недостаточно.
- [ ] RED: принудительно остановить worker при операции и проверить восстановление из journal; отдельная инъекция сбоя ровно между start и сохранением ID → uncertain без повторной загрузки. Сырые DownloadItem и URLs в reports не печатать.
- [ ] RED: `npm run test:run -- tests/privacy`, затем после test build `npm run test:integration`; сервер должен успешно стартовать, падения — на недостающем поведении.
- [ ] Реализовать compile-time test profile: только локальный fixture origin, тестовые HTTPS media endpoints и внедрение сбоев на границах adapters. Production domain/provider не содержит test-веток. Fixture origin и trust policy в test build меняются согласованно; реальный runtime sender validation остаётся задействован.
- [ ] Privacy test рекурсивно проверяет publications, operations, sourceIntents и captured logs на ключи и контрольные секретные значения; author/caption/source URL разрешены лишь в документированных полях базы. Ноль запретных ключей не заменяет проверку значений.
- [ ] GREEN: unit/component/privacy, build production/test, integration. Проверить dist: нет localhost trust, test bridge, фикстур и отключённой валидации. Commit: `test: cover extension recovery and privacy boundaries`.

## Task 10: CI, упаковка и инструкции

**Files:** Create `.github/workflows/ci.yml`, `scripts/package-extension.mjs`, `tests/scaffold/package.test.ts`, `README.md`, `docs/INSTALL.md`, `docs/PRIVACY.md`; Modify `package.json`, `package-lock.json`.

**Interfaces:** `npm run package` → `mediavault-chrome-extension.zip`, только production dist. CI — read-only contents permissions, checks на push/PR, upload ZIP.

- [ ] RED упаковки: ZIP содержит manifest/library/worker/content/icons/assets; сортировка записей и фиксированные timestamps дают одинаковый hash для одинакового входа; отсутствуют maps, tests, dist-test, `.env`, git metadata. `npm run test:run -- tests/scaffold/package.test.ts` должен падать до реализации script.
- [ ] Реализовать packager и CI: npm ci, lint, typecheck, build, unit tests, test build, Chromium installation, integration, повторная production build перед package, upload ZIP. Для browser CI настроить поддерживаемый Chromium и необходимые системные зависимости.
- [ ] Написать инструкции clean checkout, установка unpacked, режимы Save/retry/redownload, пределы/отмена, неопределённый результат, ручное повторное скачивание без перезаписи, отсутствие отслеживания удалённых файлов и сохранение файлов при удалении истории. Уточнить границу privacy с собственной историей Chrome Downloads.
- [ ] GREEN: последовательно `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:run`, `npm run build:test-extension`, `npm run test:integration`, `npm run build`, `npm run package`. Все exit codes равны 0. Проверить распакованный ZIP и manifest permissions. Commit: `ci: verify and package production extension`.

## Task 11: Ручная приёмка и решение о выпуске

**Files:** Create `docs/ACCEPTANCE.md`; при обнаружении дефекта — минимальные изменения owning source/test из предыдущих задач.

**Interfaces:** вход — собранный ZIP и разрешённый тестовый контент; выход — таблица PASS/FAIL и READY/BLOCKED с commit/browser/OS/date, без чувствительных данных.

- [ ] Установить именно распакованный release ZIP. Проверить photo/video/reel/carousel; старт карусели с середины; порядок файлов; прогресс и неподтверждённую полноту; отмену и уход на другой пост.
- [ ] Прервать один файл, открыть исходник из библиотеки и нажать «Докачать»: успешные файлы не повторяются. Изменить состав тестовой карусели: нет угадывания по индексам, предлагается повторное скачивание.
- [ ] Удалить файл вручную: библиотека не меняет прошлый успех автоматически. «Скачать повторно» запускается только после клика на исходнике и создаёт копии без перезаписи существующих файлов.
- [ ] Проверить две вкладки, повтор Save, остановку worker, перезапуск Chrome, очищенную downloads history и неудачный redownload. Для неопределённого состояния — понятный статус и отсутствие автоматических повторов.
- [ ] Проверить поиск/фильтры, persistence, folder action, history removal без удаления файлов, отсутствие секретных полей и логов. Подтвердить, что полного успеха нет до complete всех элементов и подтверждения состава.
- [ ] После исправлений повторить полную последовательность задачи 10. READY только при всех обязательных PASS; иначе BLOCKED с конкретным сценарием и причиной. Commit: `docs: record version one acceptance evidence`.

## Проверка покрытия и порядок выполнения

Порядок: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. В задаче 6 используются injected actions; production messaging подключается задачей 7. Реализацию узких инфраструктурных частей можно проверять до ручного доступа к Instagram, но задачи 5 и release acceptance нельзя считать выполненными без задачи 0.

| Договорённость / требование | Задачи |
| --- | --- |
| Ручная докачка с открытием публикации и свежими URLs | 2, 5, 6, 7, 8, 11 |
| Автоматическая карусель, пределы, порядок, полнота, отмена | 0, 5, 6, 7, 9, 11 |
| Отдельный redownload без отслеживания удалённых файлов | 2, 7, 8, 11 |
| История только после успеха; предыдущий успех сохраняется | 2, 4, 7, 9 |
| Дубли, атомарность, worker recovery, неопределённый запуск | 4, 7, 9, 11 |
| Privacy, permissions, source/sender validation | 1, 2, 4, 7, 9, 10 |
| Safe filenames, поиск/фильтры, persistence, удаление истории | 3, 4, 8, 11 |
| Install, чистая сборка, CI ZIP, ручные доказательства | 1, 9, 10, 11 |

Проверка плана — проверка документа, не запуск будущих тестов. В этой редакции команды, тесты и код ещё предстоит создать.

## Источники технических решений

- [Chrome: service worker migration](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers) — постоянное состояние и синхронная регистрация listeners; проверено через Context7 30 сентября 2026 года.
- [Chrome Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads) — downloadId, состояния, conflictAction и граница хранения URLs; проверено через Context7 30 сентября 2026 года.
- [Vite build options](https://github.com/vitejs/vite/blob/main/docs/config/build-options.md) и [build implementation](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/build.ts) — IIFE требует одного entry; проверено через Context7 1 октября 2026 года. Точные опции сборки сверить с установленной в задаче 1 версией.
