# MediaVault Chrome Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a desktop Chrome Manifest V3 extension that adds a user-initiated Save control to an open Instagram publication, downloads its accessible media, and maintains a searchable local library.

**Architecture:** A content script owns Instagram-page integration and delegates extraction to an isolated adapter. A background service worker validates typed messages, coordinates Chrome downloads, and persists sanitized records through a provider-neutral IndexedDB repository. A separate React entry point renders the library; domain, download, and persistence modules contain no Instagram DOM logic.

**Tech Stack:** TypeScript, React, Vite, Chrome Extension Manifest V3, IndexedDB via `idb`, Vitest, Testing Library, Playwright, ESLint, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-29-chrome-extension-design.md`

## Global Constraints

- Support desktop Chrome with Manifest V3.
- Version 1 handles one explicitly opened photo, video, Reel, or carousel at a time.
- Inject one **Save** control beside the active publication's standard actions.
- Save immediately after the user's click; do not add a preview dialog.
- A carousel saves every resolved item in display order.
- Store author, caption, canonical source URL, media kind, saved date, item status, safe filename, and an optional small thumbnail locally.
- Never persist or log passwords, cookies, authorization headers, access tokens, signed media URLs, transient media URLs, raw page HTML, usernames, captions, or source URLs.
- Do not request `cookies`, history, clipboard, debugger, or `<all_urls>` permissions.
- Do not bypass login, private-content controls, challenges, rate limits, or anti-automation behavior.
- Do not crawl profiles, feeds, followers, hashtags, or recommendations in Version 1.
- Removing a library record must not delete downloaded files.
- A normal repeated save must not silently duplicate completed files.
- The build must produce an unpacked distribution directory and a CI-generated ZIP.
- Use synthetic fixtures only; commit no personal accounts, media, copied production HTML, credentials, tokens, or signed URLs.

## Review Focus

- Instagram route changes without a full reload must leave exactly one control attached to the current publication; Task 6 tests mount, remount, and stale-control removal.
- A malicious or malformed content-script message must not start a download or write storage; Task 7 tests sender origin and schema rejection.
- A carousel with mixed success must preserve completed items and retry only failed items in order; Task 7 tests partial completion and retry selection.
- IndexedDB migration or quota failure must not create corrupt or empty records; Task 4 tests migration, transaction failure, and atomic writes.
- Filenames containing traversal, Windows reserved names, Unicode-only whitespace, or extreme length must remain safe and deterministic; Task 3 tests each class.

---

## File Structure

```text
.github/workflows/ci.yml              automated checks and release artifact
docs/
  INSTALL.md                          unpacked installation and troubleshooting
  PRIVACY.md                          local-data and permission disclosure
  superpowers/plans/...               this implementation plan
  superpowers/specs/...               approved design
public/
  manifest.json                       Manifest V3 declaration
  icons/                              extension-owned static icons
src/
  background/
    main.ts                           service-worker composition root
    saveCoordinator.ts                validated save/download orchestration
  content/
    main.tsx                          content-script composition root
    navigationObserver.ts             debounced SPA route/DOM observation
    SaveControl.tsx                   injected button and status UI
    mountSaveControl.tsx              idempotent mount/unmount boundary
  domain/
    models.ts                         provider-neutral domain and persisted types
    persistence.ts                    persistent-record projection and validation
  download/
    filenames.ts                      safe paths and ordered filenames
  library/
    App.tsx                           library page composition
    filters.ts                        pure search/filter behavior
    main.tsx                          library entry point
    repository.ts                     IndexedDB implementation
    styles.css                        isolated library-page styling
  providers/instagram/
    adapter.ts                        DOM-to-domain extraction boundary
    classifyPage.ts                   supported/login/unsupported classification
    selectors.ts                      semantic selectors and ordered fallbacks
  shared/
    messages.ts                       runtime message schemas and types
    result.ts                         typed success/error result
library.html                          Vite library-page entry
vite.config.ts                        multi-entry extension build
tests/
  fixtures/instagram/                 synthetic provider fixtures
  integration/                        controlled fixture-site extension tests
  setup.ts                            DOM and Chrome API test setup
```

### Task 1: Reproducible Manifest V3 scaffold

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `library.html`
- Create: `public/manifest.json`
- Create: `src/background/main.ts`
- Create: `src/content/main.tsx`
- Create: `src/library/main.tsx`
- Create: `src/library/App.tsx`
- Create: `tests/scaffold/manifest.test.ts`
- Create: `tests/setup.ts`
- Create: `.gitignore`

**Interfaces:**
- Consumes: approved design only.
- Produces: `npm run build`, `npm test`, `npm run lint`, and a `dist/` directory containing `manifest.json`, the service worker, content script, and `library.html`.

- [ ] **Step 1: Create package metadata and install the toolchain**

Use npm with scripts `build`, `test`, `test:run`, `lint`, and `typecheck`. Install React, React DOM, `idb`, Vite, TypeScript, Vitest, jsdom, Testing Library, ESLint, Chrome type definitions, and the React Vite plugin; commit the generated lockfile.

- [ ] **Step 2: Write the failing manifest build test**

In `tests/scaffold/manifest.test.ts`, assert that the source manifest is Manifest V3, names `src/background/main.ts` as the service-worker build entry through the build contract, matches only `https://www.instagram.com/*`, contains `downloads` and `storage`, and excludes `cookies`, `history`, `debugger`, `clipboardRead`, and `<all_urls>`.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm run test:run -- tests/scaffold/manifest.test.ts`  
Expected: FAIL because `public/manifest.json` and build entries do not exist.

- [ ] **Step 4: Implement the minimal multi-entry build**

Configure Vite inputs for the background worker, content script, and library page. Add a minimal valid Manifest V3 file and placeholder entry modules; copying static manifest/icons into `dist/` must not require a runtime server.

- [ ] **Step 5: Verify scaffold GREEN**

Run: `npm run test:run -- tests/scaffold/manifest.test.ts && npm run typecheck && npm run build`  
Expected: one passing test, zero TypeScript errors, and a successful `dist/` build with all required entries.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts eslint.config.js library.html public src tests .gitignore
git commit -m "build: scaffold Manifest V3 extension"
```

### Task 2: Domain contracts and privacy-safe persistence

**Files:**
- Create: `src/domain/models.ts`
- Create: `src/domain/persistence.ts`
- Create: `src/shared/result.ts`
- Create: `tests/domain/persistence.test.ts`

**Interfaces:**
- Consumes: no earlier runtime interface.
- Produces: `ResolvedPublication`, `ResolvedMediaItem`, `PublicationRecord`, `MediaItemRecord`, `MediaVaultErrorCode`, `Result<T>`, and `toPublicationRecord(resolved, completedItems, savedAt): PublicationRecord`.

- [ ] **Step 1: Write failing persistence projection tests**

Assert that a photo maps to the exact persistent fields from the spec; item order is retained; no key matching `/(cookie|token|authorization|html|mediaUrl|downloadUrl|headers)/i` appears recursively; and a projection with zero completed items returns `storage-empty-record` rather than a record.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:run -- tests/domain/persistence.test.ts`  
Expected: FAIL because the domain contracts and projection do not exist.

- [ ] **Step 3: Implement minimal typed contracts and projection**

Define discriminated publication kinds and typed error codes from specification section 10. Keep transient media locations on `ResolvedMediaItem` only and make persistent record types structurally incapable of storing them.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:run -- tests/domain/persistence.test.ts && npm run typecheck`  
Expected: all persistence tests pass with zero type errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain src/shared/result.ts tests/domain
git commit -m "feat: add privacy-safe domain contracts"
```

### Task 3: Safe download paths and duplicate identity

**Files:**
- Create: `src/download/filenames.ts`
- Create: `tests/download/filenames.test.ts`

**Interfaces:**
- Consumes: `ResolvedPublication` and `ResolvedMediaItem` from Task 2.
- Produces: `sanitizePathSegment(value: string, fallback: string): string`, `publicationKey(publication): string`, `mediaItemKey(publicationKey, index): string`, and `buildDownloadPath(publication, item): string`.

- [ ] **Step 1: Write failing path and identity tests**

Assert `MediaVault/instagram/<safe-author>/<publication-id>/01-image.jpg`; stable keys for the same publication; distinct carousel indices; and safe deterministic output for `../`, `CON`, whitespace-only Unicode, control characters, separators, and input longer than 120 characters.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:run -- tests/download/filenames.test.ts`  
Expected: FAIL because filename functions do not exist.

- [ ] **Step 3: Implement minimal sanitization and key functions**

Limit each path segment to 80 Unicode code points, replace forbidden characters with `-`, trim trailing dots/spaces, prefix reserved device names, and use the supplied fallback for empty output. Preserve the extension determined by media type.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:run -- tests/download/filenames.test.ts && npm run typecheck`  
Expected: all path and identity tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/download tests/download
git commit -m "feat: add safe download naming"
```

### Task 4: Atomic IndexedDB library repository

**Files:**
- Create: `src/library/repository.ts`
- Create: `tests/library/repository.test.ts`

**Interfaces:**
- Consumes: `PublicationRecord` and `MediaItemRecord` from Task 2.
- Produces: `LibraryRepository` with `get(id)`, `put(record)`, `remove(id)`, `list()`, `findDuplicate(sourceIdentity)`, and `updateItems(id, items, updatedAt)`; factory `openLibraryRepository(): Promise<LibraryRepository>`.

- [ ] **Step 1: Write failing repository tests**

Using fake IndexedDB, assert create/read/update/delete, duplicate lookup, saved-date descending order, schema migration from an empty version, atomic rejection of an empty-item record, and unchanged prior data when a transaction fails.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:run -- tests/library/repository.test.ts`  
Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement the IndexedDB repository**

Create database `mediavault`, version 1, store `publications`, primary key `id`, and indices `sourceIdentity` and `savedAt`. Validate records before opening a write transaction.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:run -- tests/library/repository.test.ts && npm run typecheck`  
Expected: all repository and migration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/library/repository.ts tests/library/repository.test.ts
git commit -m "feat: add local library repository"
```

### Task 5: Instagram page classification and adapter

**Files:**
- Create: `src/providers/instagram/classifyPage.ts`
- Create: `src/providers/instagram/selectors.ts`
- Create: `src/providers/instagram/adapter.ts`
- Create: `tests/providers/instagram/adapter.test.ts`
- Create: `tests/fixtures/instagram/photo.html`
- Create: `tests/fixtures/instagram/video.html`
- Create: `tests/fixtures/instagram/reel.html`
- Create: `tests/fixtures/instagram/carousel.html`
- Create: `tests/fixtures/instagram/login.html`
- Create: `tests/fixtures/instagram/unsupported.html`

**Interfaces:**
- Consumes: `ResolvedPublication`, `ResolvedMediaItem`, and `Result<T>` from Task 2.
- Produces: `classifyInstagramPage(document, location): InstagramPageState` and `resolveActivePublication(document, location): Result<ResolvedPublication>`.

- [ ] **Step 1: Create synthetic fixtures and failing classification tests**

Assert exact states `photo`, `video`, `reel`, `carousel`, `login-required`, and `unsupported-page`. The fixtures must use invented authors/captions and local non-routable media locations.

- [ ] **Step 2: Run classification tests and verify RED**

Run: `npm run test:run -- tests/providers/instagram/adapter.test.ts`  
Expected: FAIL because classifier and adapter do not exist.

- [ ] **Step 3: Implement minimal classification**

Use route shape plus semantic DOM evidence. Return unsupported when evidence conflicts; never infer a publication solely from a URL.

- [ ] **Step 4: Add failing extraction tests**

Assert author and caption when present, null when absent, canonical source without query/fragment, correct kind, ordered carousel items, and `media-not-found` when the publication shell has no resolvable media.

- [ ] **Step 5: Run extraction tests and verify RED**

Run the same focused command.  
Expected: classification tests pass; extraction tests fail because resolution is incomplete.

- [ ] **Step 6: Implement minimal adapter and isolated selector fallbacks**

Keep all selectors in `selectors.ts`. Return transient media locations only in resolved objects; do not serialize or log fixture markup.

- [ ] **Step 7: Verify GREEN**

Run: `npm run test:run -- tests/providers/instagram/adapter.test.ts && npm run typecheck`  
Expected: all provider tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/providers tests/providers tests/fixtures
git commit -m "feat: resolve active Instagram publications"
```

### Task 6: Injected Save control and SPA navigation lifecycle

**Files:**
- Create: `src/content/SaveControl.tsx`
- Create: `src/content/mountSaveControl.tsx`
- Create: `src/content/navigationObserver.ts`
- Modify: `src/content/main.tsx`
- Create: `src/content/content.css`
- Create: `tests/content/saveControl.test.tsx`
- Create: `tests/content/navigationObserver.test.ts`

**Interfaces:**
- Consumes: Task 5 page classification; `SavePublicationRequest` from Task 7 is represented initially by an injected `onSave(): Promise<SaveOutcome>` callback to avoid coupling tests to Chrome.
- Produces: `mountSaveControl(target, onSave): MountedControl`, `startNavigationObserver(onChange): StopObserver`, and UI states Ready, Saving, Saved, Already saved, Saved partially, and Error.

- [ ] **Step 1: Write failing Save-control state tests**

Assert one click calls `onSave` once; disabled Saving state; Saved, Already saved, partial, and typed Error copy; and a second click while pending does nothing.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:run -- tests/content/saveControl.test.tsx`  
Expected: FAIL because the control does not exist.

- [ ] **Step 3: Implement the minimal React control and isolated styles**

Mount into an extension-owned container and Shadow DOM so Instagram styles cannot alter the button.

- [ ] **Step 4: Write failing lifecycle tests**

Assert repeated mutations create one control, route change removes the stale control and mounts one current control, unsupported/login pages mount none, and rapid mutations produce one debounced reconciliation.

- [ ] **Step 5: Run lifecycle tests and verify RED**

Run: `npm run test:run -- tests/content/navigationObserver.test.ts`  
Expected: FAIL because observer and reconciliation do not exist.

- [ ] **Step 6: Implement observer and content composition root**

Observe a scoped page root, debounce at 100 ms, compare canonical route plus active publication identity, and always expose a stop function that disconnects observers and unmounts the control.

- [ ] **Step 7: Verify GREEN**

Run: `npm run test:run -- tests/content && npm run typecheck`  
Expected: all content tests pass and no duplicate mount is observed.

- [ ] **Step 8: Commit**

```bash
git add src/content tests/content
git commit -m "feat: inject publication save control"
```

### Task 7: Validated messaging and download coordination

**Files:**
- Create: `src/shared/messages.ts`
- Create: `src/background/saveCoordinator.ts`
- Modify: `src/background/main.ts`
- Modify: `src/content/main.tsx`
- Create: `tests/background/saveCoordinator.test.ts`
- Create: `tests/shared/messages.test.ts`

**Interfaces:**
- Consumes: resolved publication from Task 5, path/key functions from Task 3, repository from Task 4.
- Produces: runtime types `SavePublicationRequest`, `RetryMissingRequest`, `SaveOutcome`; `validateRuntimeMessage(value): Result<RuntimeMessage>`; and `SaveCoordinator.save(publication): Promise<SaveOutcome>`, `retryMissing(publicationId): Promise<SaveOutcome>`.

- [ ] **Step 1: Write failing message-validation tests**

Accept only the exact versioned message schema. Reject extra prototype-bearing objects, missing item fields, non-HTTPS transient locations, unsupported senders, negative indices, duplicate indices, and payloads above the bounded item count of 50.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:run -- tests/shared/messages.test.ts`  
Expected: FAIL because schemas do not exist.

- [ ] **Step 3: Implement minimal schema validation**

Use explicit property checks and create fresh plain objects; do not add a broad validation framework solely for two message shapes.

- [ ] **Step 4: Write failing coordinator tests**

With fake downloads and repository ports, assert: duplicate completed publication returns Already saved; successful photo writes after download completion; total failure writes nothing; mixed carousel writes completed/failed item states in order; retry selects only failed items; malformed sender/message performs no side effect.

- [ ] **Step 5: Run coordinator tests and verify RED**

Run: `npm run test:run -- tests/background/saveCoordinator.test.ts`  
Expected: FAIL because coordination does not exist.

- [ ] **Step 6: Implement minimal coordinator and worker wiring**

Define injected `DownloadsPort` and `LibraryRepository` dependencies for tests. Validate `sender.url` has HTTPS scheme and host `www.instagram.com`. Pass transient locations directly to `chrome.downloads.download`, then discard them. The action click opens `library.html` in a new tab.

- [ ] **Step 7: Connect content control to typed runtime messages**

Resolve the active publication only after a user click; map the response to Task 6 UI states. Do not resolve or download in the background observer.

- [ ] **Step 8: Verify GREEN**

Run: `npm run test:run -- tests/shared tests/background tests/content && npm run typecheck`  
Expected: all messaging, worker, and content tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/shared src/background src/content tests/shared tests/background
git commit -m "feat: coordinate validated media downloads"
```

### Task 8: Searchable local library page

**Files:**
- Create: `src/library/filters.ts`
- Modify: `src/library/App.tsx`
- Modify: `src/library/main.tsx`
- Create: `src/library/styles.css`
- Create: `tests/library/filters.test.ts`
- Create: `tests/library/App.test.tsx`

**Interfaces:**
- Consumes: `LibraryRepository` from Task 4 and retry/source/folder Chrome actions from Task 7.
- Produces: `filterRecords(records, query, kind): PublicationRecord[]` and a full library page with grid, search, kind filters, source open, downloads folder, retry missing, and history removal.

- [ ] **Step 1: Write failing pure filter tests**

Assert case-insensitive author/caption search, Photo/Video/Reel/Carousel filtering, combined query plus kind, saved-date descending order, and no mutation of input records.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:run -- tests/library/filters.test.ts`  
Expected: FAIL because filters do not exist.

- [ ] **Step 3: Implement minimal filters**

Use locale-aware lowercase matching and stable saved-date ordering.

- [ ] **Step 4: Write failing library component tests**

Assert loading/empty/error states; card metadata; fallback artwork without thumbnail; search/filter behavior; source opening; downloads-folder action; retry shown only for failed items; removal warning explicitly says files remain on disk; confirmation removes history only.

- [ ] **Step 5: Run component tests and verify RED**

Run: `npm run test:run -- tests/library/App.test.tsx`  
Expected: FAIL because the full page is not implemented.

- [ ] **Step 6: Implement the library page**

Use the repository interface rather than direct IndexedDB calls. Use `chrome.tabs.create` for source navigation and `chrome.downloads.showDefaultFolder` for the downloads folder.

- [ ] **Step 7: Verify GREEN**

Run: `npm run test:run -- tests/library && npm run typecheck && npm run build`  
Expected: all library tests pass and the built library page loads from `dist/library.html`.

- [ ] **Step 8: Commit**

```bash
git add src/library tests/library
git commit -m "feat: add searchable local library"
```

### Task 9: Browser integration harness and privacy regression

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/integration/fixtureServer.ts`
- Create: `tests/integration/extension.spec.ts`
- Create: `tests/privacy/noSensitivePersistence.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the built extension from Tasks 1–8.
- Produces: `npm run test:integration` and a browser-level fixture test that loads `dist/`.

- [ ] **Step 1: Add Playwright tooling and write the failing integration test**

The controlled site must verify one injected button, route remount without duplication, user-click messaging, library write after simulated download success, and no write after simulated failure.

- [ ] **Step 2: Run integration test and verify RED**

Run: `npm run build && npm run test:integration`  
Expected: FAIL at the first missing browser integration boundary, not because the fixture server cannot start.

- [ ] **Step 3: Implement the minimal controlled fixture bridge**

Serve only synthetic pages. Provide test-mode Chrome API adapters at build time without adding test branches to provider/domain production functions.

- [ ] **Step 4: Add privacy regression test**

Recursively inspect stored fixture records and captured logs; fail on cookies, tokens, authorization headers, transient URLs, raw HTML, username/caption/source URL values in logs, or any persistent transient-media field.

- [ ] **Step 5: Verify integration GREEN**

Run: `npm run test:run && npm run build && npm run test:integration`  
Expected: all unit/component tests and all integration scenarios pass.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts tests/integration tests/privacy package.json package-lock.json
git commit -m "test: add extension integration and privacy checks"
```

### Task 10: CI, packaging, installation, and release evidence

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `docs/INSTALL.md`
- Create: `docs/PRIVACY.md`
- Create: `README.md`
- Create: `scripts/package-extension.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: all build and test scripts from earlier tasks.
- Produces: CI checks and artifact `mediavault-chrome-extension.zip`.

- [ ] **Step 1: Write the failing packaging test**

Add a test that invokes the packaging script against a temporary build and asserts deterministic sorted ZIP entries, inclusion of manifest/library/worker/content assets, and exclusion of source maps, test files, environment files, and repository metadata.

- [ ] **Step 2: Run packaging test and verify RED**

Run: `npm run test:run -- tests/scaffold/package.test.ts`  
Expected: FAIL because the packaging script does not exist.

- [ ] **Step 3: Implement packaging and documentation**

Add `npm run package`. Document clean install, build, `chrome://extensions` loading, permissions, local data, library deletion behavior, troubleshooting, and the manual acceptance matrix from the spec.

- [ ] **Step 4: Add CI workflow**

On pull requests and pushes, run `npm ci`, lint, typecheck, unit/component tests, build, integration tests, package, and upload the ZIP artifact. Grant read-only repository contents permission.

- [ ] **Step 5: Run the complete local verification**

Run: `npm ci && npm run lint && npm run typecheck && npm run test:run && npm run build && npm run test:integration && npm run package`  
Expected: every command exits 0; `mediavault-chrome-extension.zip` exists and contains only production files.

- [ ] **Step 6: Validate the built manifest permissions**

Inspect `dist/manifest.json`. Expected: Manifest V3; only approved Instagram host access; `downloads` and `storage`; none of the prohibited permissions or `<all_urls>`.

- [ ] **Step 7: Commit**

```bash
git add .github README.md docs/INSTALL.md docs/PRIVACY.md scripts package.json package-lock.json tests/scaffold/package.test.ts
git commit -m "ci: package and verify Chrome extension"
```

### Task 11: Manual Instagram acceptance and release decision

**Files:**
- Create: `docs/ACCEPTANCE.md`
- Modify only if evidence identifies a defect: the smallest owning source/test files from Tasks 2–10.

**Interfaces:**
- Consumes: CI-built unpacked extension and ZIP; developer-controlled Instagram test account/content.
- Produces: dated acceptance evidence without sensitive values and a Version 1 READY or BLOCKED decision.

- [ ] **Step 1: Install the CI artifact as unpacked**

Follow `docs/INSTALL.md` on desktop Chrome. Record Chrome version, extension commit, operating system, and date only.

- [ ] **Step 2: Execute the manual matrix**

Test one permitted photo, video, Reel, and carousel; verify carousel order, duplicate prevention, library persistence after Chrome restart, search/filter behavior, retry of an intentionally interrupted item, and history removal without disk deletion.

- [ ] **Step 3: Inspect privacy surfaces**

Inspect extension service-worker console and IndexedDB schemas/records. Record only PASS/FAIL for absence of credentials, cookies, tokens, signed/transient media locations, raw HTML, and sensitive log values.

- [ ] **Step 4: Record evidence and decision**

Write reproducible steps and sanitized outcomes in `docs/ACCEPTANCE.md`. Mark READY only if every required scenario passes; otherwise mark BLOCKED with typed error and reproduction steps.

- [ ] **Step 5: Run final automated verification after any defect fixes**

Run: `npm ci && npm run lint && npm run typecheck && npm run test:run && npm run build && npm run test:integration && npm run package`  
Expected: all commands exit 0 after the final source change.

- [ ] **Step 6: Commit acceptance evidence**

```bash
git add docs/ACCEPTANCE.md
git commit -m "docs: record Version 1 acceptance evidence"
```
