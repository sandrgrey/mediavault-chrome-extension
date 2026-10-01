# Reel Save with One Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the existing checkout. Steps use checkbox (`- [ ]`) syntax for tracking. Сценарий согласован; этот план ожидает проверки пользователем перед реализацией.

**Goal:** По явному Save сохранить один текущий Reel со звуком после одной перезагрузки, без сбора медиаданных до клика и без угадывания дорожек.

**Architecture:** Worker резервирует операцию и одноразовое право продолжить её после reload. MAIN-world мост наблюдает ограниченный поток MP4 только после активации; изолированный content script сопоставляет активный плеер, получает полные дорожки и вызывает существующий remux. Worker проверяет отправителя и состояние операции, сохраняет итоговый Blob через Downloads и обновляет журнал; recovery использует ту же очередь.

**Tech Stack:** Manifest V3, TypeScript, Vite, React, idb, Mediabunny 1.61.0, Vitest, Playwright. Существующий lockfile, без новых runtime-зависимостей.

**Spec:** `../specs/2026-10-01-reel-reload-design.md`. Дополняет общий план `2026-10-01-chrome-extension-plan.md`, не объявляет выполненными фото/карусели и полную библиотеку.

## Global Constraints

- Существующий checkout и ветка `feat/mediavault-v1`; без клона и нового worktree. Опубликованный checkpoint `1c22175`; незакоммиченный recovery-срез сохранить.
- До Save нет копирования тел медиазапросов или накопления временных media URL. Наблюдать структуру плеера без медиасодержимого допустимо.
- После Save ровно одна ожидаемая перезагрузка той же вкладки и публикации. Нет автоматического повторения reload после сбоя.
- Сбор — 120 секунд, резервация — 150 секунд; совокупный retained capture buffer — 16 МиБ; суммарные полные входы — 64 МиБ. Лимит remux 100000 пакетов сохраняется.
- MP4 без перекодирования. В пользовательские Downloads попадает только итоговый файл, не отдельные дорожки.
- В IDB/логах нет временных URL, медиабайтов, HTML, cookies, headers или исходных исключений. URL/байты живут только в памяти ограниченной операции.
- Manifest permissions остаются downloads/storage, host permissions — Instagram. Не добавлять scripting, debugger, offscreen или CDN permissions в рамках этого плана.
- MAIN-world сообщение не является авторизацией. Worker доверяет проверенным sender tab/document/route и собственной операции; nonce страницы не считать секретом от сайта.
- Работа выполняется здесь с TDD; отдельное финальное ревью. Коммиты — локальные после проверок, push только по запросу пользователя.

## Review Focus

1. Страница меняет ролик между определением плеера и отправкой файла: Task 4 проверяет identity перед каждым переходом и не скачивает результат старого контекста.
2. Два разных ролика имеют одинаковое начало аудио/видео: Task 3 отказывается при нескольких совпадающих ресурсах, не выбирает первый.
3. Fetch response streaming/clone удерживает память после отмены: Task 3 ограничивает байты при чтении, отменяет дополнительную ветку, не ждёт зависшего cancel tee-stream и освобождает ссылки.
4. Worker завершается между reload/claim или между download/start и записью ID: Tasks 2/4 сохраняют one-shot состояние и uncertain, без повторной перезагрузки/скачивания.
5. Новая recovery-проверка конкурирует с живой операцией: Task 4 использует общий сериализатор и атомарное завершение, не освобождает чужую резервацию.

## Карта файлов и контракты

- `src/providers/instagram/reelIdentity.ts`: поддерживаемый `/reel/<code>/` или `/reels/<code>/`, canonical identity через существующий publicationKey; автор/подпись nullable.
- `src/media/reelProtocol.ts`: только типы/строгая валидация MAIN ↔ ISOLATED сообщений, лимиты и безопасные ошибки.
- `src/media/pageBridge.ts`: passive structural hooks, ограниченная activation, сопоставление MediaSource/SourceBuffer, cleanup. Отдельный IIFE `page-bridge.js` в MAIN/document_start.
- `src/media/trackAssociation.ts`: чистый алгоритм byte matching, однозначность и нормализация byte ranges; выбранные URL существуют только в памяти.
- `src/media/trackFetch.ts`: credential-free streaming fetch с лимитом/отменой; приём complete MP4, обработка HTTP/range ошибок.
- `src/storage/reloadIntents.ts`: durable one-shot reload state; migration schema 1→2 добавляет store, не изменяя старые записи.
- `src/background/reelCoordinator.ts`: begin/claim/submit/cancel/status; `src/background/operationQueue.ts`: общий сериализатор coordinator/recovery.
- `src/content/ReelSaveControl.tsx`, `reelLifecycle.ts`: кнопка, прогресс, отмена, один mount, SPA lifecycle; existing content main подключает их.
- Existing `remuxTracks` используется без переписывания. Existing blobDownload для ручной merge.html не переносится в worker: lifecycle результата Reel имеет отдельного владельца в content script.

Общие типы:

```ts
type ReelIdentity = { publicationId:string; sourceIdentity:string; sourceUrl:string };
type ReloadIntent = { tabId:number; operationId:string; publicationId:string;
  oldDocumentId:string; phase:'prepared'|'reload-issued'|'claimed';
  token:string; expiresAtMs:number; claimedDocumentId:string|null };
type ReelSession = { operationId:string; token:string; deadlineMs:number };
type TrackPair = { videoUrl:string; audioUrl:string }; // memory only
type ReadyBlob = { operationId:string; blobUrl:string; size:number; mime:'video/mp4' }; // memory only
type CaptureResult = {ok:true;value:TrackPair}|{ok:false;error:'unavailable'|'cancelled'|'publication-changed'|'collection-timeout'|'too-many-items'};
```

Bridge messages version 1: ISOLATED→MAIN `activate {session}` / `cancel {operationId}`; MAIN→ISOLATED `ready {operationId,pair}` / `failed {operationId,error}`. Запрет лишних полей, ограниченные строки; binary buffers не отправлять через JSON runtime messages. Bridge подтверждает текущий origin/source window и active session; это фильтрация, не доверенная граница с кодом сайта.

### Task 1: Доказать transport и закрепить browser harness

**Files:** Create `tests/integration/reelTransport.spec.ts`, `tests/integration/fixtureServer.ts`, `tests/fixtures/transport/manifest.json`, `content.js`, `worker.js`, `tests/fixtures/transport/page.html`. Production entry пока не менять.

**Interfaces:** `startFixtureServer():Promise<{pageOrigin:string;mediaOrigin:string;close():Promise<void>}>`; два loopback origins с CORS-политикой, tiny synthetic MP4 fixtures. Test extension: только downloads/storage и fixture host, отдельная временная папка, не production dist.

- [ ] RED browser test: content fetch из ISOLATED с credentials:omit читает две локальные дорожки с другого origin, content создаёт итоговый Blob; worker.download(blobUrl) достигает complete. Страница удерживает Blob до terminal, затем отзывает; закрытие раньше завершения не считается успехом. Сначала отсутствующие test entries дают failure; затем harness реализует только проверяемый transport.
- [ ] Run `npx playwright test tests/integration/reelTransport.spec.ts`; Expected PASS. Повторить actual origin probe на ранее разрешённом Reel с теми же production permissions в чистом Chromium; URL/cookies не переносить в репозиторий. Если CORS/Blob transport не работает — остановить зависимую реализацию и пересмотреть transport, не обходить ограничение permission.
- [ ] Зафиксировать результаты без реальных URLs в `docs/FEASIBILITY.md`; локальный commit `test: verify isolated reel blob transport`.

### Task 2: Одноразовый reload и проверка владельца

**Files:** Create `src/storage/reloadIntents.ts`, `src/providers/instagram/reelIdentity.ts`, `tests/storage/reloadIntents.test.ts`, `tests/providers/instagram/reelIdentity.test.ts`; Modify `src/storage/database.ts`.

**Interfaces:** `createReloadRepository(db)` → `prepare(operationId,owner,publicationId,nowMs):Promise<Result<ReloadIntent>>`, `markIssued(operationId):Promise<Result<void>>`, `claim(owner,publicationId,nowMs):Promise<Result<ReelSession|null>>`, `remove(operationId):Promise<Result<void>>`. Owner определяется sender. Claim атомарно меняет operation.owner.documentId и intent.phase; повтор нового document возвращает ту же session, третьего — отказ. Token не передаёт право между вкладками.

- [ ] RED: fresh schema + upgrade v1 preserve publications/operations; одна публикация/две вкладки; старый документ не claim; новый документ того же tab и identity claim один раз; чужой tab/identity, expired >150000ms и cancelled operation дают отказ. Повтор claim нового document идемпотентен; повтор markIssued не инициирует reload.
- [ ] RED: `/reel/X/` и `/reels/X/` дают одну identity; home/profile/login и URL с credentials отвергаются; sourceUrl без query/hash.
- [ ] Run `npm run test:run -- tests/storage/reloadIntents.test.ts tests/providers/instagram/reelIdentity.test.ts`; Expected FAIL до реализации, PASS после. `npm run typecheck` PASS.
- [ ] Production migration version 2 создаёт только отсутствующий reloadIntents store; deadline берётся из операции и не продлевается при повторном claim. Только worker вызывает tabs.reload после durable markIssued; ошибка markIssued исключает reload. После сбоя reload-issued автоматически не повторяется.
- [ ] Local commit `feat: reserve one-shot reel reload sessions`.

### Task 3: Ограниченный мост и точное сопоставление

**Files:** Create `src/media/reelProtocol.ts`, `pageBridge.ts`, `trackAssociation.ts`, `trackFetch.ts`, `vite.bridge.config.ts`, `tests/media/reelProtocol.test.ts`, `trackAssociation.test.ts`, `trackFetch.test.ts`, `tests/integration/reelBridge.spec.ts`; Modify `scripts/build.mjs`, `public/manifest.json`.

**Interfaces:** `installPageBridge():{dispose():void}`; `createAssociationSession(session,identity)` → `observeResponse(url,stream):Promise<void>`, `observeAppend(trackKey,bytes):void`, `resolve(videoTrackKey,audioTrackKey):CaptureResult`, `dispose():void`; `fetchTrackPair(pair,signal):Promise<Result<{video:Blob;audio:Blob}>>`. Один active session. Response streams читаются с общим budget; dispose прекращает чтение и освобождает все retained bytes/URLs.

- [ ] RED protocol: unknown version/type, extra fields, oversize payload, wrong source/origin/session rejected. До activate spies на clone/body read не вызываются. После cancel новые запросы не клонируются; hooks сохраняют native this/arguments/return/error, cleanup не перезаписывает чужую позднюю замену метода.
- [ ] RED association: reordered range responses, sliced/assembled append, два плеера с разными trackKey, одинаковые prefixes и full matching chunks. Использовать минимум два неперекрывающихся совпадения >1024 bytes на дорожку; вся совокупность должна указывать ровно на один ресурс. Дубликаты range одного origin/path считаются одним ресурсом; разные пути со совпадениями → unavailable. Не выбирать по времени/размеру/порядку.
- [ ] Только HTTPS MP4 с наблюдённых CDN hosts (`scontent-lax7-1.cdninstagram.com`, `scontent-lax3-1.cdninstagram.com`, `scontent-lax3-2.cdninstagram.com`), без credentials. Неизвестные hosts отклонять; расширять список только после evidence. Нормализация удаляет bytestart/byteend, остальные query сохраняются лишь в памяти.
- [ ] RED budgets: 16MiB retained capture, один stream не обходит лимит, 120000ms, abort during tee read, never-ending stream, empty/malformed body. Лимит full fetch 64MiB суммарно независимо от Content-Length; HTTP error и incomplete/ranged body → failure. Credentials omit; никакого retry после отмены.
- [ ] Run `npm run test:run -- tests/media` RED→GREEN. Browser test synthetic MSE + cross-origin MP4: correct pairs only after activate, before activate zero capture, cancel/route change releases session. `npx playwright test tests/integration/reelBridge.spec.ts` PASS; `npm run build` PASS, classic IIFE bridge, manifest permissions unchanged.
- [ ] Local commit `feat: associate reel tracks with bounded media capture`.

### Task 4: Save coordinator, remux и UI

**Files:** Create `src/background/operationQueue.ts`, `reelCoordinator.ts`, `src/shared/reelMessages.ts`, `src/content/ReelSaveControl.tsx`, `reelLifecycle.ts`, tests в `tests/background/reelCoordinator.test.ts`, `tests/shared/reelMessages.test.ts`, `tests/content/reelSaveControl.test.tsx`; Modify `src/background/main.ts`, `recovery.ts`, `src/storage/operations.ts`, `src/content/main.tsx`, `vite.content.config.ts`.

**Interfaces:** `createOperationQueue().run<T>(job:()=>Promise<T>):Promise<T>`; `createReelCoordinator(deps)` → `begin(owner,identity,requestId,mode)`, `claim(owner,identity)`, `submit(owner,readyBlob)`, `cancel(owner,operationId)`, `status(owner,operationId)`, each Promise<Result<...>>. Runtime version 1 commands `reel-begin|reel-claim|reel-submit|reel-cancel|reel-status`. Begin mode SaveMode использует existing duplicate semantics. UI → runtime only; page bridge не вызывает coordinator напрямую.

- [ ] RED sender validation: runtime.id, integer tabId, frameId 0, documentId, supported current route; claimed owner matches operation. Strict plain payload, no extra/prototype-bearing fields, blobUrl exact Instagram origin + blob scheme, mime video/mp4, integer size >0 within output bound derived from 64MiB inputs. Payload owner/source arbitrary URL не принимаются.
- [ ] RED orchestration: begin reserve→markIssued→one tabs.reload; claim→activate→capture→fetch→remux→submit. До готового MP4 ноль Downloads. Single logical item video/mp4 index0, stableItemId null: не изобретать устойчивость из shortcode. Для журнала добавить metadata-only attachReelResult вместо фиктивного HTTPS downloadUrl; validation атомарно формирует безопасный filename без сохранения blob URL.
- [ ] dispatching before Chrome start; ID write then immediate status search covers early completion; blob stays alive until terminal, status re-read on reconnect. Failure after start before ID persistence → uncertain, no retry. Worker restart loses live registry, reconciles durable IDs without replay.
- [ ] Shared queue guards recovery + mutations. Do not hold queue while waiting for media/remux/network completion. Track live sessions in memory; recovery may reconcile IDs but cannot terminate their pending dispatch. Atomic settle uses current cancel/items/reservation; stale snapshot cannot release a new reservation. Очистить errorCode при explicit null patch, regression for uncertain→downloading.
- [ ] RED UI: trusted Save click once, text «Для сохранения страница будет перезагружена», busy disables duplicate, progress without invented network percent, cancel, failed/uncertain/completed. Shadow root isolates styles. Debounce 100ms; 20 mutations→one reconciliation; route/manual scroll away invalidates old session. Reject ambiguity if more than one substantial visible player. No background media extraction before click.
- [ ] Run targeted unit tests RED→GREEN; `npm run test:run`, `npm run typecheck`, `npm run lint`, `npm run build` all PASS. Existing manual merge.html unchanged in behavior.
- [ ] Local commit `feat: save one reel through a verified reload session`.

### Task 5: Полная браузерная приёмка и отчёт

**Files:** Create `tests/integration/reelSave.spec.ts`, `tests/privacy/reelPersistence.test.ts`, `scripts/build-test-extension.mjs`; Modify `package.json`, `docs/FEASIBILITY.md`, production/test fixture build configuration as needed. Test dist separate from dist.

**Interfaces:** `npm run build:test-extension` creates dist-test with only synthetic origins policy, `npm run test:integration` runs Playwright. Production has no test bridge, loopback host permission or injected fault flags.

- [ ] RED full synthetic flow: one click→one reload→single final MP4 complete→one journal/library record; packet content matches fixture. Neighbor source requests interleaved cannot substitute a track.
- [ ] Worker termination before/after claim, before start/ID persistence, after completion; repeat begin/claim/events; cancellation and navigation at every async boundary; no duplicate download/reload. Use proven CDP closeTarget + disappearance/reappearance, not assumption of changed target ID.
- [ ] Privacy traverse all stores and captured logs: no URLs/buffers/HTML/cookies/secrets; no collection before click; no retained buffers after cancel. Library keeps prior success on failed redownload.
- [ ] Run full unit, typecheck, lint, production/test build, 3 existing integration tests + new suite. Expected all PASS. Verify production manifest assets and unchanged permissions.
- [ ] Manual acceptance on allowed real Reel and another independently supplied permitted Reel, plus route change/scroll/cancel. Verify at least one actual downloaded output with ffprobe/decode. Do not claim universal Instagram support from fixtures or one example. If second sample unavailable, mark acceptance partial, not complete.
- [ ] Fresh independent review scoped to feature; fix Important/Critical via RED→GREEN. Update feasibility and user-facing results with verified scope and limits; local commit `test: verify reel save and privacy boundaries`. Publish only on user request.

## Самопроверка плана

Spec coverage: one reload/owner → Task2; no pre-click collection, matching, memory/time → Task3; isolated transport → Task1; remux/download/recovery/UI → Task4; real acceptance/privacy → Task5. Interfaces use one ReelSession and ReadyBlob contract throughout. Photos/carousels and full library remain in the original plan. Execution method preserved: inline in current chat with one final independent reviewer.
