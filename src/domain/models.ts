import type { MediaVaultErrorCode } from '../shared/result';

export type SaveMode = 'save' | 'retry' | 'redownload';
export type PublicationKind = 'photo' | 'video' | 'reel' | 'carousel';
export type CollectionStatus = 'complete' | 'partial';
export type ItemState = 'pending' | 'dispatching' | 'downloading' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export type OperationState = 'collecting' | 'downloading' | 'stopping' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'needs-user' | 'uncertain';
export type SourceIntent = { publicationId: string; mode: 'view' | 'retry' | 'redownload' };
export type Owner = { tabId: number; documentId: string };
export type ResolvedMediaItem = {
  index: number; stableItemId: string | null; mediaType: 'image' | 'video';
  extension: 'jpg' | 'png' | 'webp' | 'mp4'; downloadUrl: string;
};
export type PublicationMetadata = {
  id: string; provider: 'instagram'; sourceIdentity: string; sourceUrl: string;
  author: string | null; caption: string | null; kind: PublicationKind;
};
export type ResolvedPublication = PublicationMetadata & {
  collectionStatus: CollectionStatus; expectedCount: number | null; items: ResolvedMediaItem[];
};
export type MediaItemRecord = Omit<ResolvedMediaItem, 'downloadUrl' | 'extension'> & {
  filename: string; downloadId: number | null; status: 'completed' | 'failed'; errorCode: MediaVaultErrorCode | null;
};
export type PublicationRecord = PublicationMetadata & {
  savedAt: string; updatedAt: string; thumbnail: Blob | null;
  collectionStatus: CollectionStatus; expectedCount: number | null; items: MediaItemRecord[];
};
export type OperationItem = Omit<MediaItemRecord, 'status'> & { status: ItemState };
export type OperationRecord = {
  id: string; requestId: string; publicationId: string; mode: SaveMode; owner: Owner;
  state: OperationState; collectDeadlineMs: number; metadata: PublicationMetadata | null;
  collectionStatus: CollectionStatus; expectedCount: number | null; items: OperationItem[];
  cancelRequested: boolean; createdAt: string; updatedAt: string; superseded: boolean;
};
export type BeginInput = {
  requestId: string; publicationId: string; mode: SaveMode; owner: Owner; nowMs: number;
};
export type BeginOutcome = { kind: 'accepted'; operationId: string } |
  { kind: 'already-saved' | 'busy' | 'retry-required' | 'needs-review' };
export type SubmitInput = { operationId: string; publication: ResolvedPublication; owner: Owner };
export type CollectionProgress = { found: number; expected: number | null };
export type OperationView = Pick<OperationRecord, 'id' | 'publicationId' | 'state' | 'mode'> & {
  found: number; expected: number | null; completed: number; failed: number;
};
