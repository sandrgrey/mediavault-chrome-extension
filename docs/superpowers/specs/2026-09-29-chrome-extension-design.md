# MediaVault Chrome Extension — Design Specification

Status: approved design, pending implementation plan  
Date: 2026-09-29  
Repository: `sandrgrey/mediavault-chrome-extension`

## 1. Purpose

MediaVault is a desktop Chrome extension for saving media that the user can already view on Instagram into a local archive. Version 1 adds a Save control directly to an open Instagram post or Reel, downloads the media after an explicit user action, and records a searchable local history.

The first release validates reliable, user-initiated saving of one open publication at a time. The architecture keeps Instagram-specific extraction separate from download and library code so later versions can add bounded profile or feed collection without rewriting the core.

## 2. Version 1 scope

Version 1 supports:

- open Instagram photo posts;
- open Instagram video posts;
- open Reels;
- open carousel posts, saving every item in display order;
- an injected **Save** button beside the publication's standard actions;
- immediate saving without a separate preview dialog;
- visible states on the injected control: Ready, Saving, Saved, and Error;
- browser downloads into a deterministic MediaVault folder structure;
- a separate extension page containing the local library;
- local history, duplicate detection, search, filters, source navigation, and retry for missing files.

A user action is required for every publication. The extension does not crawl profiles, feeds, followers, hashtags, or recommendations in the background.

## 3. Explicit exclusions

Version 1 does not:

- collect or store passwords, cookies, authorization headers, access tokens, signed media URLs, or raw page HTML;
- bypass authentication, private-content controls, challenges, rate limits, or anti-automation protections;
- save media that is not visible to the signed-in user;
- upload library data or media to a server;
- provide cloud synchronization;
- perform scheduled or unattended collection;
- promise compatibility after every Instagram markup change;
- automatically delete files from disk when a library record is deleted.

Users remain responsible for downloading and using content only when they have the right to do so.

## 4. Technology

- Chrome Extension Manifest V3
- TypeScript
- React
- Vite
- IndexedDB for local library records
- Chrome Downloads API for file downloads
- Vitest for unit and component tests
- Playwright with a controlled local fixture site for extension integration tests

No runtime server is required. The release artifact is an unpacked extension directory and a ZIP suitable for later Chrome Web Store preparation.

## 5. Architecture

### 5.1 Modules

#### Content script

Runs only on supported Instagram pages. It:

- identifies the currently open publication;
- mounts one MediaVault control near the publication action area;
- observes Instagram's client-side navigation and remounts idempotently;
- delegates extraction to the Instagram adapter;
- sends a typed save request to the service worker;
- renders save progress and actionable errors.

It does not write to IndexedDB or start downloads directly.

#### Instagram adapter

Owns all Instagram DOM interpretation. It converts the active page into a provider-neutral `ResolvedPublication`:

- stable source identity when observable;
- source URL;
- author display identifier when observable;
- caption when observable;
- publication kind;
- ordered media items;
- transient download location for each item.

Selectors, fallback strategies, and extraction fixtures live only in this module. Raw HTML and transient media locations never enter persistent storage or logs.

#### Background service worker

Coordinates a save operation:

1. validates the sender and request shape;
2. checks duplicate identity;
3. creates safe filenames;
4. immediately sends transient media locations to the Downloads API;
5. tracks completion or failure;
6. writes the final library record only after at least one item succeeds;
7. reports progress to the active content script.

A carousel preserves completed items and allows an explicit retry of missing items.

#### Download core

Provider-neutral code responsible for:

- deterministic folder and filename generation;
- filename sanitization;
- item ordering;
- duplicate item keys;
- download lifecycle mapping;
- retry eligibility.

It does not import Instagram selectors or page types.

#### Library repository

Stores records in IndexedDB and exposes typed operations for:

- create or update after a successful save;
- query by author or caption;
- filter by media kind;
- sort by saved date;
- mark item completion and failure;
- delete history records;
- find duplicates.

#### Library page

A full React page available from the extension action. It shows:

- a responsive card grid;
- locally stored thumbnail or fallback media-type artwork;
- author, shortened caption, kind, item count, and saved date;
- filters for Photo, Video, Reel, and Carousel;
- search by author and caption;
- Open source;
- Show downloads folder;
- Retry missing files;
- Remove from library.

Removing a record affects IndexedDB only. The UI clearly states that downloaded files remain on disk.

### 5.2 Dependency rule

```text
Instagram content script -> Instagram adapter -> shared domain model
Background worker -> download core + library repository
Library page -> library repository
```

The library and download core never depend on Instagram page structure. The adapter never owns storage policy.

## 6. User flow

1. The user signs into Instagram through the normal Instagram website.
2. The user opens a post or Reel.
3. The extension injects a **Save** button near the standard publication actions.
4. The user presses **Save**.
5. The button changes to **Saving…**.
6. The adapter resolves the current publication and ordered media items.
7. The worker starts downloads immediately.
8. The button shows **Saved** when all items complete, or **Saved partially** with a retry action when only some items complete.
9. A library record appears after the first successful item.
10. A repeated save of the same publication reports **Already saved** and does not silently create duplicate files.

No preview confirmation is shown in Version 1.

## 7. Storage model

### 7.1 Publication record

```ts
type PublicationRecord = {
  id: string;
  provider: "instagram";
  sourceIdentity: string;
  sourceUrl: string;
  author: string | null;
  caption: string | null;
  kind: "photo" | "video" | "reel" | "carousel";
  savedAt: string;
  updatedAt: string;
  thumbnail: Blob | null;
  items: MediaItemRecord[];
};
```

### 7.2 Media item record

```ts
type MediaItemRecord = {
  index: number;
  mediaType: "image" | "video";
  filename: string;
  downloadId: number | null;
  status: "completed" | "failed";
  errorCode: string | null;
};
```

Persistent records must not include cookies, tokens, headers, raw HTML, or transient/signed media locations.

### 7.3 Duplicate identity

Preferred publication identity is an observable stable Instagram media identifier. If one is unavailable, the adapter derives a deterministic non-secret fingerprint from the canonical source location without persisting query parameters. An item key is:

`provider + publicationIdentity + carouselIndex`

An explicit retry may replace or redownload a failed or missing item. A normal Save action does not duplicate completed items.

### 7.4 Download destination

Default relative structure:

`MediaVault/instagram/<safe-author>/<publication-id>/`

Filenames preserve carousel order:

- `01-image.jpg`
- `02-video.mp4`

Unknown authors use `unknown-author`. All path segments are sanitized, length-bounded, and protected against reserved names and traversal characters. Chrome remains the authority for the user's actual Downloads directory.

## 8. Permissions and privacy

Required Manifest V3 permissions are limited to:

- `downloads`;
- `storage`;
- the minimum Instagram host access needed for the content script.

The implementation must not request `cookies`, browsing history, clipboard, debugger, or broad all-site access.

Media delivery hosts may vary. Before adding any CDN host permission, implementation must capture a reproducible, non-sensitive observation and choose the narrowest supported permission. If Chrome can download the active media location without added host access, no CDN permission is added.

All library information stays in the browser profile. Logs use typed status codes and counts only. They must not contain usernames, captions, source URLs, media URLs, page HTML, cookies, or tokens.

## 9. Dynamic-page resilience

Instagram uses client-side navigation and changes markup over time. The integration therefore:

- treats navigation as route changes rather than full reloads;
- uses a scoped MutationObserver with debouncing;
- performs idempotent mounting using an extension-owned marker;
- anchors controls by semantic structure where possible;
- isolates selector fallbacks in the Instagram adapter;
- returns `unsupported-page` instead of guessing when confidence is insufficient;
- removes stale controls when the active publication changes.

The observer never scans or serializes the complete document.

## 10. Error handling

Typed user-facing errors:

- `unsupported-page`: the active view is not a supported publication;
- `login-required`: Instagram is displaying a sign-in state;
- `media-not-found`: publication detected but no supported media resolved;
- `unavailable`: media is no longer accessible;
- `download-failed`: Chrome rejected or interrupted the download;
- `partial-carousel`: at least one carousel item failed;
- `storage-failed`: local history could not be written;
- `extension-updated`: an in-flight request was interrupted by an extension update.

Permanent errors are not retried automatically. Missing carousel items can be retried by explicit user action. Failed extraction never creates an empty library record.

## 11. Testing strategy

### Unit tests

- page classification;
- provider-neutral mapping;
- publication and item identity;
- filename and path sanitization;
- carousel ordering;
- duplicate prevention;
- transient-field exclusion from persisted records;
- error classification;
- library search and filtering.

### Fixture-based adapter tests

Sanitized, synthetic HTML fixtures cover:

- photo;
- video;
- Reel;
- carousel;
- login page;
- unsupported view;
- missing optional author or caption;
- markup fallback.

Fixtures contain no personal media, accounts, cookies, tokens, signed locations, or copied production HTML.

### Component tests

- Save button states;
- partial-save messaging;
- library grid;
- filters and search;
- deletion warning;
- retry action.

### Extension integration tests

A controlled local fixture site verifies:

- content-script injection;
- idempotent remounting after route changes;
- content-to-worker message validation;
- download request construction;
- IndexedDB write after success;
- no record after total failure.

### Manual acceptance

Using a developer-controlled Instagram test account and content the developer may download:

- save one photo;
- save one video;
- save one Reel;
- save a carousel and verify order;
- revisit and confirm duplicate prevention;
- close and reopen Chrome and verify library persistence;
- verify removal from history does not delete disk files;
- verify no sensitive values appear in extension logs or stored records.

Manual evidence records only result, browser/extension version, media type, and reproducibility.

## 12. Delivery and installation

Version 1 is delivered first as an unpacked developer build:

1. run the documented build command;
2. open `chrome://extensions`;
3. enable Developer mode;
4. choose **Load unpacked**;
5. select the generated distribution directory.

The repository will provide a ZIP release artifact after automated checks pass. Chrome Web Store publication is a separate release task requiring a permissions, privacy, branding, and policy review.

## 13. Future evolution

### Version 1.1

- configurable folder naming;
- export and import of library metadata;
- improved missing-file detection;
- optional quality selection when multiple observable variants exist.

### Version 2: bounded bulk mode

Bulk collection is a separate feature gate. It requires:

- explicit selection of a profile or collection;
- visible item count and bounded queue;
- rate-aware concurrency;
- pause, resume, and cancellation;
- no bypass of login challenges or server limits;
- separate tests and user approval before implementation.

Version 1 must not include dormant background crawling.

### Android relationship

The domain model, filename policy, duplicate identity, and sanitized extraction concepts may later be ported to the Android application. Chrome-specific APIs, DOM mounting, IndexedDB, and service-worker code are not shared directly. The desktop extension remains independently usable.

## 14. Acceptance criteria

Version 1 is complete only when:

- the extension builds reproducibly from a clean checkout;
- all automated tests pass;
- the Save control appears exactly once on supported active publications;
- photo, video, Reel, and carousel manual scenarios are recorded;
- downloads are user-initiated and ordered;
- duplicate saves do not create silent copies;
- the local library persists across browser restart;
- search and type filters work;
- failed extraction creates no empty record;
- persistent storage and logs contain none of the prohibited sensitive fields;
- install and troubleshooting instructions are documented;
- the release ZIP is produced by CI.

## 15. Implementation boundary

This document approves the product and technical design only. Implementation begins after:

1. the user reviews this committed specification;
2. an implementation plan is written and approved;
3. tasks are executed test-first with verification evidence.
