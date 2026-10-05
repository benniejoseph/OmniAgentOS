import { AsyncLocalStorage } from "node:async_hooks";
import {
  OAuthProviderError,
  type OAuthProvider,
} from "@/lib/connectors/oauth-providers";
import {
  claimOAuthSyncLease,
  getOAuthGrantSecrets,
  listOAuthGrantsForTenant,
  updateOAuthSyncState,
  OAuthCredentialError,
  type NormalizedOAuthGrant,
  type OAuthSourceCoverageCheckpoint,
  type OAuthSyncLease,
} from "@/lib/connectors/oauth-store";
import { getActiveGoogleWorkspaceAccess } from "@/lib/connectors/google-workspace-access";
import { GOOGLE_SOURCE_ADAPTERS } from "@/lib/connectors/google-source-adapters";
import { googleSyncSourcesForScopes } from "@/lib/connectors/google-workspace-capabilities";
import {
  deferSourceItem,
  dueSourceItems,
  noteSourceItemChange,
  quarantinedSourceItem,
  readSourceItemQuarantine,
  recordSourceItemFailure,
  releaseSourceItem,
  settleSourceItems,
  sourceItemQuarantineValue,
  type QuarantinedSourceItem,
  type SourceItemQuarantine,
} from "@/lib/connectors/source-item-quarantine";
import {
  advanceSourceDocumentSweep,
  readSourceDocumentSweep,
  sourceDocumentSliceStops,
  startSourceDocumentSweep,
  SOURCE_DOCUMENT_SWEEP,
  type SourceDocumentSweep,
} from "@/lib/connectors/source-document-sweep";
import { observeGoogleDriveCanonicalMetadata } from "@/lib/connectors/google-drive-canonical";
import { observeGoogleDriveShadow } from "@/lib/connectors/google-drive-shadow";
import { extractCaptureFile } from "@/lib/capture/files";
import { ingestTextDocument } from "@/lib/rag/retriever";
import {
  deleteKnowledgeDocumentByIdempotencyKey,
  getActorOwnedKnowledgeForCognition,
  getCanonicalKnowledgeEvidenceByChunkIds,
  getKnowledgeDocumentByIdempotencyKey,
  knowledgeDocumentId,
  listKnowledgeDocumentsBySourcePrefix,
} from "@/lib/rag/store";
import { normalizeTextForChunking } from "@/lib/rag/chunk";
import {
  cancelGoogleCalendarMeeting,
  projectGoogleCalendarMeeting,
  type GoogleCalendarMeetingEvent,
} from "@/lib/meetings/google-calendar-projection";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { mapInboundCommunication } from "@/lib/communications/store";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { KNOWLEDGE_COGNIFY_PURPOSE_ID } from "@/lib/sources/purposes";
import { contentSha256Hex } from "@/lib/sources/text-lineage";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import {
  readResponseBytesLimited,
  readResponseTextLimited,
} from "@/lib/http/body";

type SyncCursor = {
  calendar?: string;
  calendarPageToken?: string;
  calendarTimeMin?: string;
  calendarTimeMax?: string;
  calendarMeetingProjectionVersion?: 1;
  gmailHistoryId?: string;
  gmailPageToken?: string;
  gmailPendingHistoryId?: string;
  gmailPendingAddedIds?: string[];
  gmailPendingDeletedIds?: string[];
  gmailBackfillPageToken?: string;
  gmailBackfillHistoryId?: string;
  driveModifiedAfter?: string;
  drivePageToken?: string;
  driveWindowStart?: string;
  driveWindowEnd?: string;
  /** Drive's change position, read before a listing window's first page. */
  driveChangesFence?: string;
  driveChangesStartPageToken?: string;
  driveChangesPageToken?: string;
  /** Each source's items set aside after they kept failing. */
  itemQuarantine?: Record<string, unknown>;
  /** Each source's check of the documents it held when it started over. */
  documentSweep?: Record<string, unknown>;
};

const GMAIL_ITEM_PAGE_SIZE = GOOGLE_SOURCE_ADAPTERS.mail.pageLimit;
const GMAIL_HISTORY_RECORD_PAGE_SIZE = 10;
const GMAIL_PENDING_ITEM_LIMIT = 5_000;
// Anyone can land mail in spam, and trash is mail the owner discarded, so
// knowledge holds neither.
const GMAIL_EXCLUDED_LABEL_IDS = new Set(["SPAM", "TRASH"]);
const CALENDAR_ITEM_PAGE_SIZE = GOOGLE_SOURCE_ADAPTERS.calendar.pageLimit;
const DRIVE_ITEM_PAGE_SIZE = GOOGLE_SOURCE_ADAPTERS.drive.pageLimit;
const GOOGLE_DRIVE_FILE_FIELDS =
  "id,name,mimeType,createdTime,modifiedTime,version,headRevisionId,webViewLink,description,trashed,size,fileExtension,ownedByMe";
const GOOGLE_DRIVE_REVISION_MARKER_KEY = "googleDriveProviderRevision";
const GOOGLE_DRIVE_REVISION_MARKER_VERSION = 1;
const GOOGLE_DRIVE_REUSE_MAX_CHUNKS = 128;
// Each Google request, with its body, gets this long before its source fails.
const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
// A Drive export keeps 100,000 characters, and UTF-8 spends at most four bytes
// on each, so the rest of a longer export is never read.
const DRIVE_EXPORT_READ_BYTES = 400_000;
type SyncItem = {
  id: string;
  kind: "mail" | "calendar" | "drive";
  title: string;
  content: string;
  deleted?: boolean;
  /**
   * Never ingested, and retired if this account indexed it: Gmail spam or
   * trash, or a Drive file that was trashed, deleted, or is no longer the
   * account's own.
   */
  excluded?: boolean;
  providerRevisionId?: string;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
  capturedAt?: string;
  metadata?: Record<string, unknown>;
  communication?: {
    provider: "gmail";
    providerMessageId: string;
    externalThreadId: string;
    fromAddress: string;
    toAddress: string;
    subject: string;
    content: string;
    receivedAt: string;
  };
  calendarEvent?: GoogleCalendarMeetingEvent;
};
type PersonalSourceId = SyncItem["kind"];
type GoogleSourceObservation = Readonly<{
  source: PersonalSourceId;
  items: SyncItem[];
  cursor: Partial<SyncCursor>;
  /** The source started over from a fresh listing. */
  relisted?: true;
}>;
type GoogleSourcePage = Pick<
  GoogleSourceObservation,
  "items" | "cursor" | "relisted"
>;
type GoogleSourceObservationSettlement = Readonly<
  | {
      source: PersonalSourceId;
      status: "fulfilled";
      value: GoogleSourceObservation;
    }
  | { source: PersonalSourceId; status: "rejected"; reason: unknown }
>;
type PersonalSourceSettlement = Readonly<{
  source: PersonalSourceId;
  status: "syncing" | "healthy" | "error";
  backfillState: OAuthSourceCoverageCheckpoint["backfillState"];
  lastAttemptedAt: string;
  lastSuccessfulAt?: string;
  failureCode?: OAuthSourceCoverageCheckpoint["failureCode"];
  imported: number;
  removed: number;
  error?: string;
}>;
type GoogleDriveSyncIdentity = Readonly<{
  tenantId: string;
  actorId: string;
  provider: OAuthProvider;
  idempotencyPrefix: string;
}>;
type GoogleDriveRevisionMarker = Readonly<{
  schemaVersion: typeof GOOGLE_DRIVE_REVISION_MARKER_VERSION;
  snapshotSha256: string;
}>;
type SourceItemOutcome = "imported" | "removed" | "skipped";
type SourceItemEvent = Readonly<{
  id: string;
  streamId: string;
  type: string;
  payload: Record<string, unknown>;
}>;

function googleConnectionSourceNamespace(grant: NormalizedOAuthGrant) {
  if (grant.connectionPurpose === "personal") {
    return {
      idempotencyPrefix: "oauth:google",
      sourcePrefix: "google",
      externalPrefix: "",
    } as const;
  }
  return {
    idempotencyPrefix: `oauth:google:work:${grant.id}`,
    sourcePrefix: `google:work:${grant.id}`,
    externalPrefix: `work:${grant.id}`,
  } as const;
}

export async function syncDuePersonalProviders(options: {
  tenantId: string;
  limit?: number;
  staleAfterMs?: number;
  abortSignal?: AbortSignal;
}) {
  const limit = Math.min(Math.max(options.limit || 2, 1), 5);
  const now = Date.now();
  const staleBefore = now - (options.staleAfterMs || 30 * 60_000);
  const grants = (await listOAuthGrantsForTenant(options.tenantId))
    .filter((grant) =>
      (!grant.lastSyncedAt || Date.parse(grant.lastSyncedAt) <= staleBefore) &&
      // A connection whose last syncs reached none of its sources waits.
      (!grant.syncRetryAt || Date.parse(grant.syncRetryAt) <= now)
    )
    .slice(0, limit);
  const results: Array<{ provider: OAuthProvider; status: "healthy" | "error"; imported?: number; error?: string }> = [];
  for (const grant of grants) {
    if (options.abortSignal?.aborted) break;
    try {
      const synced = await syncPersonalProvider({
        tenantId: grant.tenantId,
        actorId: grant.actorId,
        provider: grant.provider,
        connectionId: grant.id,
        abortSignal: options.abortSignal,
      });
      results.push({
        provider: grant.provider,
        status: synced.status === "healthy" ? "healthy" : "error",
        imported: synced.imported,
        ...(synced.error ? { error: synced.error } : {}),
      });
    } catch (error) {
      results.push({ provider: grant.provider, status: "error", error: error instanceof Error ? error.message : "Sync failed." });
    }
  }
  return results;
}

export type GooglePersonalNativeExecution = Readonly<{ lease: OAuthSyncLease;expectedSources: readonly PersonalSourceId[];expectedScopeSha256: string;
  beforeProvider: () => Promise<void>;commit: <T>(work: () => Promise<T>,releaseLease?: boolean) => Promise<T> }>;
const nativePersonalExecution = new AsyncLocalStorage<GooglePersonalNativeExecution>();
type PersonalSyncInput = { tenantId: string; actorId: string; provider: OAuthProvider; connectionId?: string; sources?: PersonalSourceId[]; abortSignal?: AbortSignal;
  /** An explicit native Calendar command never follows a renewed authorization. */
  expectedAuthorizationGeneration?: number; expectedAccountEmail?: string;native?: GooglePersonalNativeExecution };
export function syncPersonalProvider(input: PersonalSyncInput) {
  return runWithDatabaseActorScope(
    input.tenantId,
    [input.actorId],
    () => input.native ? nativePersonalExecution.run(input.native,() => syncPersonalProviderWithActorScope(input)) : syncPersonalProviderWithActorScope(input),
  );
}

async function syncPersonalProviderWithActorScope(input: PersonalSyncInput) {
  if (input.provider !== "google") {
    throw new Error("Personal synchronization supports Google connections only.");
  }
  await input.native?.beforeProvider();
  const local = <T>(work: () => Promise<T>,releaseLease = false) => input.native ? input.native.commit(work,releaseLease) : work();
  const secrets = await getOAuthGrantSecrets(
    input.tenantId,
    input.actorId,
    input.provider,
    input.connectionId ? { connectionId: input.connectionId } : undefined,
  );
  if (!secrets) throw new Error("Connected source not found.");
  if (input.expectedAuthorizationGeneration !== undefined && (
    !input.connectionId || (!input.native && (input.sources?.length !== 1 || input.sources[0] !== "calendar")) ||
    secrets.grant.id !== input.connectionId || secrets.grant.authorizationGeneration !== input.expectedAuthorizationGeneration ||
    secrets.grant.accountEmail !== input.expectedAccountEmail || secrets.grant.connectionPurpose !== "personal" ||
    (!input.native && !googleSyncSourcesForScopes(secrets.grant.scopes).includes("calendar"))
  )) throw new Error("The reviewed Calendar connection authorization changed.");
  if (input.native && (input.expectedAuthorizationGeneration === undefined || !input.expectedAccountEmail ||
    sourceContractSha256(input.sources) !== sourceContractSha256(input.native.expectedSources) ||
    sourceContractSha256(googleSyncSourcesForScopes(secrets.grant.scopes)) !== sourceContractSha256(input.native.expectedSources) ||
    sourceContractSha256([...new Set(secrets.grant.scopes)].sort()) !== input.native.expectedScopeSha256))
    throw new Error("The exact reviewed Google source permissions changed.");
  const grantedSources = googleSyncSourcesForScopes(secrets.grant.scopes).filter((source) =>
    !input.sources?.length || input.sources.includes(source)
  );
  const claim = input.native ? { status: "claimed" as const,lease: input.native.lease } : await claimOAuthSyncLease({
    tenantId: input.tenantId,
    actorId: input.actorId,
    provider: input.provider,
    connectionId: secrets.grant.id,
    expectedAuthorizationGeneration: input.expectedAuthorizationGeneration,
  });
  if (claim.status !== "claimed") {
    throw new Error("Connected source synchronization is already running.");
  }
  const lease = claim.lease;
  let driveSidecarAccessToken: string | undefined;
  let driveSidecarsReady = false;
  let sourceObservationStarted = false;
  const startDriveShadow = (accessToken: string) =>
    observeGoogleDriveShadow({
      accessToken,
      tenantId: input.tenantId,
      actorId: input.actorId,
      connectionId: secrets.grant.id,
      authorizationGeneration: secrets.grant.authorizationGeneration,
      abortSignal: input.abortSignal,
    }).catch(() => undefined);
  const startDriveCanonical = (accessToken: string) =>
    observeGoogleDriveCanonicalMetadata({
      accessToken,
      tenantId: input.tenantId,
      actorId: input.actorId,
      connectionId: secrets.grant.id,
      authorizationGeneration: secrets.grant.authorizationGeneration,
      abortSignal: input.abortSignal,
    }).catch(() => undefined);
  try {
    const cursor = prepareCalendarMeetingProjectionCursor(
      parseCursor(secrets.syncCursor),
      grantedSources,
    );
    const sourceNamespace = googleConnectionSourceNamespace(secrets.grant);
    const sourceIdentity: GoogleDriveSyncIdentity = {
      tenantId: input.tenantId,
      actorId: input.actorId,
      provider: input.provider,
      idempotencyPrefix: sourceNamespace.idempotencyPrefix,
    };
    let providerHeaders: Record<string, string> = {};
    let observations: readonly GoogleSourceObservationSettlement[] = [];
    if (grantedSources.length) {
      const { accessToken } = await getActiveGoogleWorkspaceAccess({
        tenantId: input.tenantId,
        actorId: input.actorId,
        connectionId: secrets.grant.id,
        capability: GOOGLE_SOURCE_ADAPTERS[grantedSources[0]].capability,
        expectedAuthorizationGeneration: input.expectedAuthorizationGeneration,
        expectedAccountEmail: input.expectedAccountEmail,
        ...(input.native ? { beforeProvider: input.native.beforeProvider } : {}),
      });
      if (grantedSources.includes("drive")) {
        driveSidecarAccessToken = accessToken;
      }
      providerHeaders = {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      };
      sourceObservationStarted = true;
      observations = await observeGoogleSources(
        providerHeaders,
        cursor,
        grantedSources,
        input.abortSignal,
        sourceIdentity,
      );
    }
    const sourceExecutionScope = createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "connector.google.personal_sync",
      correlationId: personalSyncCorrelationId({
        tenantId: input.tenantId,
        actorId: input.actorId,
        connectionId: secrets.grant.id,
        authorizationGeneration: secrets.grant.authorizationGeneration,
      }),
      contextGrantIds: [secrets.grant.id],
      purpose: "connector.google.personal_sync.ingest",
    });
    let nextCursor = { ...cursor };
    const sources: PersonalSourceSettlement[] = [];
    let fenceLost = false;
    // Settles one provider item into knowledge: retires it when its source no
    // longer offers it, and otherwise ingests its current revision.
    const settleSourceItem = async (item: SyncItem): Promise<SourceItemOutcome> => {
      await input.native?.beforeProvider();
      const idempotencyKey = `${sourceNamespace.idempotencyPrefix}:${item.kind}:${item.id}`;
      if (item.excluded) {
        // Retirement is a heavy transaction, and most excluded items were
        // never indexed; one indexed earlier, before a move to trash for
        // example, is retired.
        if (!await getKnowledgeDocumentByIdempotencyKey(idempotencyKey, {
          tenantId: input.tenantId,
        })) return "skipped";
        await local(() => deleteKnowledgeDocumentByIdempotencyKey(idempotencyKey, {
          tenantId: input.tenantId,
          executionScope: sourceExecutionScope,
        }));
        return "removed";
      }
      if (item.deleted) {
        if (item.kind === "calendar") {
          const existingDocument = await getKnowledgeDocumentByIdempotencyKey(
            idempotencyKey,
            { tenantId: input.tenantId },
          );
          if (existingDocument?.sourceItemId) {
            const sourceItemId = existingDocument.sourceItemId;
            await local(() => cancelGoogleCalendarMeeting({
              tenantId: input.tenantId,
              actorId: input.actorId,
              sourceItemId,
              sourceExecutionScope,
              providerRevisionId: item.providerRevisionId || item.id,
            }));
          }
        }
        await local(() => deleteKnowledgeDocumentByIdempotencyKey(idempotencyKey, {
          tenantId: input.tenantId,
          executionScope: sourceExecutionScope,
        }));
        return "removed";
      }
      if (!item.content.trim()) return "skipped";
      if (!item.capturedAt) {
        throw new Error(
          `Google ${item.kind} item is missing a canonical provider timestamp.`,
        );
      }
      const capturedAt = item.capturedAt;
      const existingCalendarDocument = item.calendarEvent
        ? await getKnowledgeDocumentByIdempotencyKey(idempotencyKey, {
            tenantId: input.tenantId,
          })
        : undefined;
      let projectedExistingCalendar = false;
      if (
        !input.native &&
        item.calendarEvent &&
        existingCalendarDocument?.sourceItemId &&
        existingCalendarDocument.sourceRevisionId
      ) {
        const event = item.calendarEvent,sourceItemId = existingCalendarDocument.sourceItemId,sourceRevisionId = existingCalendarDocument.sourceRevisionId;
        // Calendar-to-Meeting projection is deliberately independent of
        // the heavier embedding/canonicalization repair below. Existing
        // Calendar evidence can therefore make the Meetings page current
        // immediately, even while knowledge backfill continues.
        await local(() => projectGoogleCalendarMeeting({
          tenantId: input.tenantId,
          actorId: input.actorId,
          event,
          sourceItemId,
          sourceRevisionId,
          sourceExecutionScope,
          providerRevisionId: item.providerRevisionId || item.id,
        }));
        projectedExistingCalendar = true;
      }
      const ingest = () => ingestTextDocument({
        idempotencyKey,
        tenantId: input.tenantId,
        title: item.title,
        content: item.content,
        source: `${sourceNamespace.sourcePrefix}:${item.kind}:${item.id}`,
        sourceType: "api",
        tags: ["connected-source", input.provider, item.kind],
        metadata: item.metadata,
        abortSignal: input.abortSignal,
        // Provider backfills can touch several documents in one bounded
        // page. Persist canonical evidence immediately; cognition owns
        // semantic memory while the graph queue remains coalesced.
        deferMemoryGraphIndex: true,
        // A retry after the document commit must replay communication,
        // meeting, entity, and graph projections without purchasing the
        // same exact revision's embeddings again.
        reuseExactCommittedRevision: true,
        ...(input.native ? {
          beforeEmbeddingProvider: input.native.beforeProvider,failOnEmbeddingError: true,commitSourceProjection: input.native.commit,
          prepareSourceProjection: async () => {
            // A changed revision replaces its old local projection in the same
            // guarded commit, after one embedding attempt. Exact reuse skips it.
            if (await getKnowledgeDocumentByIdempotencyKey(idempotencyKey,{ tenantId: input.tenantId }))
              await deleteKnowledgeDocumentByIdempotencyKey(idempotencyKey,{ tenantId: input.tenantId,executionScope: sourceExecutionScope });
          },
        } : {}),
        usageScope: {
          tenantId: input.tenantId,
          actorId: input.actorId,
          sourceStreamId: `connector-sync:${input.provider}:${input.actorId}:${secrets.grant.id}:${item.kind}`,
          operation: "embedding",
          purpose: `connector.${input.provider}.${item.kind}.ingest`,
          credentialSource: "deployment_environment",
        },
        sourceLineage: {
          executionScope: sourceExecutionScope,
          connectionId: secrets.grant.id,
          adapterId: GOOGLE_SOURCE_ADAPTERS[item.kind].adapterId,
          adapterVersionId: GOOGLE_SOURCE_ADAPTERS[item.kind].adapterVersionId,
          externalItemId: `${item.kind}:${item.id}`,
          providerRevisionId: item.providerRevisionId || null,
          sourceKind: GOOGLE_SOURCE_ADAPTERS[item.kind].sourceKind,
          sourceCreatedAt: item.sourceCreatedAt || null,
          sourceUpdatedAt: item.sourceUpdatedAt || null,
          capturedAt,
        },
      });
      let knowledge;
      try {
        knowledge = await ingest();
      } catch (error) {
        if (input.native) throw error;
        if (!isReplaceableKnowledgeConflict(error)) throw error;
        // Knowledge ids are stable for a provider item. If the provider
        // publishes a new revision, retire the old derived document and
        // retry the same governed ingest instead of binding one immutable
        // id to two payloads.
        await deleteKnowledgeDocumentByIdempotencyKey(idempotencyKey, {
          tenantId: input.tenantId,
          executionScope: sourceExecutionScope,
        });
        input.abortSignal?.throwIfAborted();
        knowledge = await ingest();
      }
      if (
        item.calendarEvent &&
        !projectedExistingCalendar &&
        knowledge?.document?.sourceItemId &&
        knowledge.document.sourceRevisionId
      ) {
        const event = item.calendarEvent,sourceItemId = knowledge.document.sourceItemId,sourceRevisionId = knowledge.document.sourceRevisionId;
        await local(() => projectGoogleCalendarMeeting({
          tenantId: input.tenantId,
          actorId: input.actorId,
          event,
          sourceItemId,
          sourceRevisionId,
          sourceExecutionScope,
          providerRevisionId: item.providerRevisionId || item.id,
        }));
      }
      if (item.communication) {
        const communication = item.communication;
        await local(() => mapInboundCommunication({
          ...communication,
          providerMessageId: sourceNamespace.externalPrefix
            ? `${sourceNamespace.externalPrefix}:${communication.providerMessageId}`
            : communication.providerMessageId,
          externalThreadId: sourceNamespace.externalPrefix
            ? `${sourceNamespace.externalPrefix}:${communication.externalThreadId}`
            : communication.externalThreadId,
        }, {
          tenantId: input.tenantId,
          actorId: input.actorId,
          executionScope: sourceExecutionScope,
        }));
      }
      return "imported";
    };
    const sourceItemEvents: SourceItemEvent[] = [];
    // Records the set-aside decisions a write just made durable. The cursor
    // holds each decision, so an event that fails to append loses only the
    // record of it.
    const recordSourceItemEvents = async () => {
      for (const event of sourceItemEvents.splice(0)) {
        try {
          await appendScopedDomainEvent({
            ...event,
            executionScope: sourceExecutionScope,
          });
        } catch (error) {
          console.warn(JSON.stringify({
            level: "warn",
            event: "connector.source_item.event_failed",
            type: event.type,
            diagnostic: safeSourceSyncError(error),
          }));
        }
      }
    };
    // Checks one slice of the documents a source held when it started over,
    // and retires those whose item left the source meanwhile. A slice that
    // fails to check leaves the sweep where it was for the next sync.
    const sweepSourceDocuments = async (
      source: PersonalSourceId,
      sweep: SourceDocumentSweep,
      count: (outcome: SourceItemOutcome) => void,
    ): Promise<SourceDocumentSweep | undefined> => {
      const prefix = `${sourceNamespace.sourcePrefix}:${source}:`;
      const presence = async (id: string): Promise<GoogleSourcePresence> => {
        try {
          return await googleSourcePresence(
            source,
            id,
            providerHeaders,
            input.abortSignal,
          );
        } catch (error) {
          if (
            isPersonalSyncInterruption(error, input.abortSignal) ||
            personalSourceFailureCode(error) !== "processing_failed"
          ) throw error;
          return "unknown";
        }
      };
      try {
        const listed = await listKnowledgeDocumentsBySourcePrefix(prefix, {
          tenantId: input.tenantId,
          createdBefore: sweep.since,
          after: sweep.after,
          limit: SOURCE_DOCUMENT_SWEEP.slice,
        });
        const checked: Array<Readonly<{ id: string; presence: GoogleSourcePresence }>> = [];
        for (
          let start = 0;
          start < listed.length;
          start += SOURCE_DOCUMENT_SWEEP.concurrency
        ) {
          checked.push(...await Promise.all(listed
            .slice(start, start + SOURCE_DOCUMENT_SWEEP.concurrency)
            .map(async (document) => {
              const id = document.source.slice(prefix.length);
              // Only a document this connection's sync wrote for the item
              // is checked; any other is left as it is.
              return {
                id,
                presence: id && knowledgeDocumentId(
                  input.tenantId,
                  `${sourceNamespace.idempotencyPrefix}:${source}:${id}`,
                ) === document.id
                  ? await presence(id)
                  : "unknown" as const,
              };
            })));
        }
        const present = checked.filter((document) =>
          document.presence === "present"
        ).length;
        const gone = checked.filter((document) =>
          document.presence === "deleted" || document.presence === "excluded"
        );
        if (sourceDocumentSliceStops(sweep, { present, gone: gone.length })) {
          sourceItemEvents.push(sourceSweepEvent(
            "stopped",
            secrets.grant.id,
            source,
            sweep,
            { wouldRemove: gone.length },
          ));
          return undefined;
        }
        for (const document of gone) {
          count(await settleSourceItem({
            id: document.id,
            kind: source,
            title: "Removed source item",
            content: "",
            ...(document.presence === "deleted"
              ? { deleted: true }
              : { excluded: true }),
          }));
        }
        const next = advanceSourceDocumentSweep(sweep, {
          listed: listed.length,
          lastId: listed.at(-1)?.id,
          present,
          gone: gone.length,
        });
        if (!next.finished) return next.sweep;
        if (next.sweep.checked) {
          sourceItemEvents.push(sourceSweepEvent(
            "finished",
            secrets.grant.id,
            source,
            next.sweep,
            {},
          ));
        }
        return undefined;
      } catch (error) {
        if (isPersonalSyncInterruption(error, input.abortSignal)) throw error;
        console.warn(JSON.stringify({
          level: "warn",
          event: "connector.source_sweep.failed",
          source,
          diagnostic: safeSourceSyncError(error),
        }));
        return sweep;
      }
    };
    for (const observation of observations) {
      if (observation.status === "rejected") {
        if (input.native) throw observation.reason;
        if (isPersonalSyncInterruption(observation.reason, input.abortSignal)) {
          throw observation.reason;
        }
        const lastAttemptedAt = new Date().toISOString();
        sources.push({
          source: observation.source,
          status: "error",
          backfillState: googleSourceBackfillState(observation.source, nextCursor),
          lastAttemptedAt,
          failureCode: personalSourceFailureCode(observation.reason),
          imported: 0,
          removed: 0,
          error: safeSourceSyncError(observation.reason),
        });
        continue;
      }
      const source = observation.source;
      let sourceImported = 0;
      let sourceRemoved = 0;
      let quarantine = readSourceItemQuarantine(
        record(nextCursor.itemQuarantine)[source],
      );
      // A source that starts over checks again every document it held.
      let sweep = observation.value.relisted
        ? startSourceDocumentSweep(Date.now())
        : readSourceDocumentSweep(record(nextCursor.documentSweep)[source]);
      const count = (outcome: SourceItemOutcome) => {
        if (outcome === "imported") sourceImported += 1;
        if (outcome === "removed") sourceRemoved += 1;
      };
      try {
        let processingFailure: { error: unknown } | undefined;
        for (const item of observation.value.items) {
          if (quarantinedSourceItem(quarantine, item.id)) {
            // A set-aside item waits for its next read, which comes sooner
            // when its source removed or changed it since it failed.
            quarantine = noteSourceItemChange(quarantine, {
              id: item.id,
              revision: item.providerRevisionId,
              removed: Boolean(item.deleted || item.excluded),
            }, Date.now());
            continue;
          }
          try {
            count(await settleSourceItem(item));
          } catch (error) {
            if (input.native) throw error;
            // Only a failure to process the item itself can set it aside.
            if (
              isPersonalSyncInterruption(error, input.abortSignal) ||
              personalSourceFailureCode(error) !== "processing_failed"
            ) throw error;
            const failure = recordSourceItemFailure(quarantine, {
              id: item.id,
              revision: item.providerRevisionId,
            }, Date.now());
            quarantine = failure.state;
            const { failing, quarantined } = failure;
            if (!failing || !quarantined) {
              // Keep the page in place, but let due items leave quarantine
              // before reporting its failure. Otherwise a full quarantine
              // could never free capacity while this item keeps failing.
              processingFailure = { error };
              break;
            }
            sourceItemEvents.push(sourceItemEvent(
              "quarantined",
              secrets.grant.id,
              source,
              quarantined,
              { attempts: failing.attempts, failureCode: "processing_failed" },
            ));
          }
        }
        for (const due of input.native ? [] : dueSourceItems(quarantine, Date.now())) {
          let read: SyncItem | undefined;
          try {
            read = await googleSourceItem(
              source,
              due.id,
              providerHeaders,
              input.abortSignal,
              sourceIdentity,
            );
            count(await settleSourceItem(read));
            quarantine = releaseSourceItem(quarantine, due.id);
            sourceItemEvents.push(sourceItemEvent(
              "released",
              secrets.grant.id,
              source,
              due,
              {
                outcome: read.deleted || read.excluded ? "removed" : "ingested",
                redrives: due.redrives,
              },
            ));
          } catch (error) {
            if (isPersonalSyncInterruption(error, input.abortSignal)) throw error;
            quarantine = deferSourceItem(
              quarantine,
              due.id,
              Date.now(),
              read ? { revision: read.providerRevisionId } : undefined,
            );
          }
        }
        if (processingFailure) throw processingFailure.error;
        quarantine = settleSourceItems(quarantine);
        if (sweep && !input.native) sweep = await sweepSourceDocuments(source, sweep, count);
        const candidateCursor = withSourceDocumentSweep(
          withSourceItemQuarantine(
            { ...nextCursor, ...observation.value.cursor },
            source,
            quarantine,
          ),
          source,
          sweep,
        );
        const lastSuccessfulAt = new Date().toISOString();
        const backfillState = googleSourceBackfillState(
          observation.source,
          candidateCursor,
        );
        const sourceStatus = backfillState === "complete"
          ? "healthy" as const
          : "syncing" as const;
        const checkpoint = await local(() => updateOAuthSyncState({
          ...input,
          connectionId: secrets.grant.id,
          status: "syncing",
          cursor: JSON.stringify(candidateCursor),
          syncedItems: sourceImported,
          lease,
          sourceSettlements: [{
            source: observation.source,
            schemaVersion: 1,
            status: sourceStatus,
            backfillState,
            lastAttemptedAt: lastSuccessfulAt,
            lastSuccessfulAt,
            failureCode: "none",
          }],
        }));
        if (!checkpoint) {
          // The connection was revoked, or this sync lost its lease, so no
          // later source may be ingested under it.
          fenceLost = true;
          throw new Error("Connected source was revoked during synchronization.");
        }
        nextCursor = candidateCursor;
        await recordSourceItemEvents();
        sources.push({
          source: observation.source,
          status: sourceStatus,
          backfillState,
          lastAttemptedAt: lastSuccessfulAt,
          lastSuccessfulAt,
          failureCode: "none",
          imported: sourceImported,
          removed: sourceRemoved,
        });
      } catch (error) {
        if (input.native) throw error;
        if (fenceLost || isPersonalSyncInterruption(error, input.abortSignal)) {
          throw error;
        }
        // The source keeps its place, and what it learned about its items.
        nextCursor = withSourceItemQuarantine(nextCursor, source, quarantine);
        const lastAttemptedAt = new Date().toISOString();
        sources.push({
          source: observation.source,
          status: "error",
          backfillState: googleSourceBackfillState(observation.source, nextCursor),
          lastAttemptedAt,
          failureCode: personalSourceFailureCode(error),
          imported: sourceImported,
          removed: sourceRemoved,
          error: safeSourceSyncError(error),
        });
      }
    }
    const imported = sources.reduce((sum, source) => sum + source.imported, 0);
    const removed = sources.reduce((sum, source) => sum + source.removed, 0);
    const failed = sources.filter((source) => source.status === "error");
    const advancing = sources.filter((source) => source.status === "syncing");
    const status = failed.length
      ? failed.length === sources.length ? "error" as const : "partial" as const
      : advancing.length ? "partial" as const : "healthy" as const;
    driveSidecarsReady = sources.some((source) =>
      source.source === "drive" && source.status !== "error"
    );
    const error = failed.length
      ? failed.map((source) => `${source.source}: ${source.error}`).join("; ")
      : undefined;
    const grant = await local(() => updateOAuthSyncState({
      ...input,
      connectionId: secrets.grant.id,
      status: failed.length ? "error" : advancing.length ? "syncing" : "healthy",
      cursor: JSON.stringify(nextCursor),
      error,
      lease,
      releaseLease: true,
      attempt: failed.length && failed.length === sources.length
        ? "failed"
        : "succeeded",
      sourceSettlements: sources.map((source) => ({
        source: source.source,
        schemaVersion: 1,
        status: source.status,
        backfillState: source.backfillState,
        lastAttemptedAt: source.lastAttemptedAt,
        ...(source.lastSuccessfulAt
          ? { lastSuccessfulAt: source.lastSuccessfulAt }
          : {}),
        ...(source.failureCode ? { failureCode: source.failureCode } : {}),
      })),
    }),true);
    if (!grant) {
      throw new Error("Connected source synchronization lost its lease.");
    }
    await recordSourceItemEvents();
    return {
      provider: input.provider,
      status,
      imported,
      removed,
      cursorAdvanced: sourcePosition(cursor) !== sourcePosition(nextCursor),
      sources,
      error,
      grant,
    };
  } catch (error) {
    if (input.native) throw error;
    const interrupted = isPersonalSyncInterruption(error, input.abortSignal);
    const lastAttemptedAt = new Date().toISOString();
    await updateOAuthSyncState({
      ...input,
      connectionId: secrets.grant.id,
      status: interrupted ? "syncing" : "error",
      error: interrupted
        ? undefined
        : error instanceof Error ? error.message : "Sync failed.",
      lease,
      releaseLease: true,
      // An interrupted sync resumes on the next tick.
      ...(interrupted ? {} : { attempt: "failed" as const }),
      sourceSettlements: interrupted || sourceObservationStarted
        ? []
        : grantedSources.map((source) => ({
            source,
            schemaVersion: 1 as const,
            status: "error" as const,
            backfillState: googleSourceBackfillState(source, parseCursor(secrets.syncCursor)),
            lastAttemptedAt,
            failureCode: personalSourceFailureCode(error),
          })),
    });
    throw error;
  } finally {
    if (
      !input.native && driveSidecarAccessToken &&
      driveSidecarsReady &&
      !input.abortSignal?.aborted
    ) {
      // Vercel intentionally gives this route a one-slot database pool. Run
      // the optional Drive ledgers only after the legacy cursor and sync lease
      // have settled so their transactions cannot starve the authoritative
      // ingest. Prioritize the active generation-3 canonical pilot, then keep
      // the generation-1 hash-only shadow advancing. Both helpers own and
      // suppress their failures, so neither can change legacy sync health.
      await startDriveCanonical(driveSidecarAccessToken);
      await startDriveShadow(driveSidecarAccessToken);
    }
  }
}

async function observeGoogleSources(
  headers: Record<string, string>,
  cursor: SyncCursor,
  sources: readonly PersonalSourceId[],
  signal?: AbortSignal,
  identity?: GoogleDriveSyncIdentity,
): Promise<readonly GoogleSourceObservationSettlement[]> {
  const requests = sources.map((source) => ({
    source,
    promise: source === "mail"
      ? googleMail(headers, cursor, signal)
      : source === "calendar"
        ? googleCalendar(headers, cursor, signal)
        : googleDrive(headers, cursor, signal, identity),
  }));
  const settled = await Promise.allSettled(
    requests.map((request) => request.promise),
  );
  return settled.map((result, index): GoogleSourceObservationSettlement => {
    const source = requests[index].source;
    return result.status === "fulfilled"
      ? {
          source,
          status: "fulfilled",
          value: {
            source,
            items: result.value.items,
            cursor: result.value.cursor,
            ...(result.value.relisted ? { relisted: true } : {}),
          },
        }
      : { source, status: "rejected", reason: result.reason };
  });
}

/**
 * Reads one item again by its id, for a redrive. An item its source no longer
 * has, or that is no longer the account's own, comes back removed.
 */
async function googleSourceItem(
  source: PersonalSourceId,
  id: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  identity?: GoogleDriveSyncIdentity,
): Promise<SyncItem> {
  if (source === "mail") {
    const [item] = await gmailItems(headers, [id], [], signal);
    if (item?.id !== id) {
      throw new Error("Gmail returned another item than the one requested.");
    }
    return item;
  }
  if (source === "calendar") {
    const response = await providerJson(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
      headers,
      signal,
      [404, 410],
    );
    if (response.status === 404 || response.status === 410) {
      return { id, kind: "calendar", title: "Removed calendar event", content: "", deleted: true };
    }
    if (response.body.id !== id) {
      throw new Error("Google Calendar returned another item than the one requested.");
    }
    return googleEvent(response.body);
  }
  const response = await providerJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(GOOGLE_DRIVE_FILE_FIELDS)}`,
    headers,
    signal,
    [404],
  );
  const file = response.body;
  if (response.status !== 404 && file.id !== id) {
    throw new Error("Google Drive returned another item than the one requested.");
  }
  return response.status === 404 || file.trashed === true ||
      file.ownedByMe !== true
    ? { id, kind: "drive", title: "Removed Drive file", content: "", excluded: true }
    : googleDriveItem(file, headers, signal, identity);
}

type GoogleSourcePresence = "present" | "deleted" | "excluded" | "unknown";

/**
 * Whether a source still offers an item, read by its id with only the fields
 * that tell. Only an answer about the item asked for removes it, so an answer
 * about another item, or one that does not say, keeps it.
 */
async function googleSourcePresence(
  source: PersonalSourceId,
  id: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<GoogleSourcePresence> {
  if (source === "mail") {
    const response = await providerJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=minimal`,
      headers,
      signal,
      [404],
    );
    if (response.status === 404) return "deleted";
    if (response.body.id !== id) return "unknown";
    return hasExcludedGmailLabel(response.body.labelIds) ? "excluded" : "present";
  }
  if (source === "calendar") {
    const response = await providerJson(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}?fields=id%2Cstatus`,
      headers,
      signal,
      [404, 410],
    );
    if (response.status === 404 || response.status === 410) return "deleted";
    if (response.body.id !== id) return "unknown";
    return response.body.status === "cancelled" ? "deleted" : "present";
  }
  const response = await providerJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id%2Ctrashed%2CownedByMe`,
    headers,
    signal,
    [404],
  );
  if (response.status === 404) return "excluded";
  if (response.body.id !== id) return "unknown";
  return response.body.trashed === true || response.body.ownedByMe === false
    ? "excluded"
    : "present";
}

async function googleMail(
  headers: Record<string, string>,
  cursor: SyncCursor,
  signal?: AbortSignal,
): Promise<GoogleSourcePage> {
  let addedIds: string[] = [];
  let deletedIds: string[] = [];
  if (cursor.gmailHistoryId) {
    const pendingAddedIds = googleCursorIds(cursor.gmailPendingAddedIds);
    const pendingDeletedIds = googleCursorIds(cursor.gmailPendingDeletedIds);
    if (pendingAddedIds.length || pendingDeletedIds.length) {
      if (!cursor.gmailPendingHistoryId) {
        throw new Error("Gmail continuation is missing its history fence.");
      }
      const pending = boundedGmailItems(
        pendingAddedIds,
        pendingDeletedIds,
      );
      return {
        items: await gmailItems(
          headers,
          pending.addedIds,
          pending.deletedIds,
          signal,
        ),
        cursor: gmailHistoryContinuationCursor({
          historyId: cursor.gmailHistoryId,
          pendingHistoryId: cursor.gmailPendingHistoryId,
          nextPageToken: cursor.gmailPageToken,
          remainingAddedIds: pending.remainingAddedIds,
          remainingDeletedIds: pending.remainingDeletedIds,
        }),
      };
    }
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
    url.searchParams.set("startHistoryId", cursor.gmailHistoryId);
    url.searchParams.set("maxResults", String(GMAIL_HISTORY_RECORD_PAGE_SIZE));
    if (cursor.gmailPageToken) {
      url.searchParams.set("pageToken", cursor.gmailPageToken);
    }
    const response = await providerJson(url.toString(), headers, signal, [404]);
    if (response.status === 404) return googleMail(headers, {}, signal);
    const payload = response.body;
    addedIds = googleProviderIds(array(payload.history).flatMap((entry) => [
      ...array(record(entry).messagesAdded).map((added) =>
        String(record(record(added).message).id || "")
      ),
      // A message moved into or out of spam or trash is fetched again, and
      // its current labels decide whether it is indexed or retired.
      ...[
        ...array(record(entry).labelsAdded),
        ...array(record(entry).labelsRemoved),
      ]
        .filter((change) => hasExcludedGmailLabel(record(change).labelIds))
        .map((change) => String(record(record(change).message).id || "")),
    ]));
    deletedIds = googleProviderIds(array(payload.history).flatMap((entry) =>
      array(record(entry).messagesDeleted).map((deleted) =>
        String(record(record(deleted).message).id || "")
      )
    ));
    const nextPageToken = optionalProviderString(payload.nextPageToken);
    const pendingHistoryId = String(
      payload.historyId || cursor.gmailPendingHistoryId || cursor.gmailHistoryId,
    );
    const bounded = boundedGmailItems(addedIds, deletedIds);
    const items = await gmailItems(
      headers,
      bounded.addedIds,
      bounded.deletedIds,
      signal,
    );
    return {
      items,
      cursor: gmailHistoryContinuationCursor({
        historyId: cursor.gmailHistoryId,
        pendingHistoryId,
        nextPageToken,
        remainingAddedIds: bounded.remainingAddedIds,
        remainingDeletedIds: bounded.remainingDeletedIds,
      }),
    };
  }

  const historyFence = cursor.gmailBackfillHistoryId || String(
    (await providerJson(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      headers,
      signal,
    )).body.historyId || "",
  );
  if (!historyFence) throw new Error("Gmail profile returned no history fence.");
  const listUrl = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  );
  listUrl.searchParams.set("maxResults", String(GMAIL_ITEM_PAGE_SIZE));
  listUrl.searchParams.set("q", "newer_than:30d");
  if (cursor.gmailBackfillPageToken) {
    listUrl.searchParams.set("pageToken", cursor.gmailBackfillPageToken);
  }
  const list = await providerJson(listUrl.toString(), headers, signal);
  const listedMessages = array(list.body.messages);
  if (listedMessages.length > GMAIL_ITEM_PAGE_SIZE) {
    throw new Error("Gmail backfill page exceeds the requested item limit.");
  }
  addedIds = googleProviderIds(listedMessages
    .map((item) => String(record(item).id || ""))
  );
  const items = await gmailItems(headers, addedIds, [], signal);
  const nextPageToken = optionalProviderString(list.body.nextPageToken);
  return {
    items,
    ...(cursor.gmailBackfillHistoryId ? {} : { relisted: true as const }),
    cursor: nextPageToken
      ? {
          gmailHistoryId: undefined,
          gmailPageToken: undefined,
          gmailPendingHistoryId: undefined,
          gmailBackfillPageToken: nextPageToken,
          gmailBackfillHistoryId: historyFence,
        }
      : {
          gmailHistoryId: historyFence,
          gmailPageToken: undefined,
          gmailPendingHistoryId: undefined,
          gmailBackfillPageToken: undefined,
          gmailBackfillHistoryId: undefined,
        },
  };
}

async function gmailItems(
  headers: Record<string, string>,
  addedIds: string[],
  deletedIds: string[],
  signal?: AbortSignal,
) {
  if (addedIds.length + deletedIds.length > GMAIL_ITEM_PAGE_SIZE) {
    throw new Error("Gmail page exceeds the bounded item limit.");
  }
  const added = await Promise.all(addedIds.map(async (id): Promise<SyncItem> => {
    const response = await providerJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
      headers,
      signal,
      [404],
    );
    if (response.status === 404) {
      return { id, kind: "mail", title: "Removed email", content: "", deleted: true };
    }
    if (response.body.id !== id) {
      throw new Error("Gmail returned another item than the one requested.");
    }
    return hasExcludedGmailLabel(response.body.labelIds)
      ? { id, kind: "mail", title: "Excluded email", content: "", excluded: true }
      : googleMessage(response.body);
  }));
  return [
    ...added,
    ...deletedIds.map((id): SyncItem => ({
      id,
      kind: "mail",
      title: "Removed email",
      content: "",
      deleted: true,
    })),
  ];
}

async function googleCalendar(
  headers: Record<string, string>,
  cursor: SyncCursor,
  signal?: AbortSignal,
): Promise<GoogleSourcePage> {
  const initial = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  initial.searchParams.set("maxResults", String(CALENDAR_ITEM_PAGE_SIZE)); initial.searchParams.set("singleEvents", "true"); initial.searchParams.set("showDeleted", "true"); initial.searchParams.set("conferenceDataVersion", "1");
  const timeMin = cursor.calendarTimeMin || new Date(Date.now() - 30 * 86_400_000).toISOString();
  const timeMax = cursor.calendarTimeMax || new Date(Date.now() + 365 * 86_400_000).toISOString();
  if (cursor.calendar) initial.searchParams.set("syncToken", cursor.calendar);
  else {
    initial.searchParams.set("timeMin", timeMin);
    initial.searchParams.set("timeMax", timeMax);
  }
  if (cursor.calendarPageToken) {
    initial.searchParams.set("pageToken", cursor.calendarPageToken);
  }
  const first = await providerJson(initial.toString(), headers, signal, [410]);
  if (first.status === 410) {
    return googleCalendar(headers, {}, signal);
  }
  const payload = first.body;
  const providerItems = array(payload.items);
  if (providerItems.length > CALENDAR_ITEM_PAGE_SIZE) {
    throw new Error("Google Calendar page exceeds the requested item limit.");
  }
  const items = providerItems.map((item) => googleEvent(record(item)));
  const nextPageToken = optionalProviderString(payload.nextPageToken);
  return {
    items,
    ...(cursor.calendar || cursor.calendarPageToken
      ? {}
      : { relisted: true as const }),
    cursor: nextPageToken
      ? {
          calendar: cursor.calendar,
          calendarPageToken: nextPageToken,
          calendarTimeMin: cursor.calendar ? undefined : timeMin,
          calendarTimeMax: cursor.calendar ? undefined : timeMax,
          calendarMeetingProjectionVersion: cursor.calendarMeetingProjectionVersion,
        }
      : {
          calendar: String(payload.nextSyncToken || cursor.calendar || "") || undefined,
          calendarPageToken: undefined,
          calendarTimeMin: undefined,
          calendarTimeMax: undefined,
          calendarMeetingProjectionVersion: 1 as const,
        },
  };
}

function prepareCalendarMeetingProjectionCursor(
  cursor: SyncCursor,
  sources: readonly PersonalSourceId[],
): SyncCursor {
  if (
    !sources.includes("calendar") ||
    cursor.calendarMeetingProjectionVersion === 1 ||
    cursor.calendarPageToken ||
    !cursor.calendar
  ) return cursor;
  return {
    ...cursor,
    calendar: undefined,
    calendarPageToken: undefined,
    calendarTimeMin: undefined,
    calendarTimeMax: undefined,
  };
}

async function googleDrive(
  headers: Record<string, string>,
  cursor: SyncCursor,
  signal?: AbortSignal,
  identity?: GoogleDriveSyncIdentity,
): Promise<GoogleSourcePage> {
  const changesPageToken = cursor.driveChangesPageToken ||
    cursor.driveChangesStartPageToken;
  if (changesPageToken) {
    return googleDriveChanges(headers, changesPageToken, signal, identity);
  }
  // A listing never shows a file leaving the account, so each window starts
  // by reading Drive's change position, and the change feed takes over from
  // that position once the window ends. The position is read before the
  // window's end is fixed, so every later change reaches the feed. A window
  // already in progress without a position ends as before, and the next
  // window reads one.
  const fence = cursor.drivePageToken
    ? cursor.driveChangesFence
    : await googleDriveStartPageToken(headers, signal);
  const windowStart = cursor.driveWindowStart || cursor.driveModifiedAfter ||
    new Date(Date.now() - 30 * 86_400_000).toISOString();
  const windowEnd = cursor.driveWindowEnd || new Date().toISOString();
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", String(DRIVE_ITEM_PAGE_SIZE));
  url.searchParams.set("orderBy", "modifiedTime,name");
  url.searchParams.set("fields", `nextPageToken,files(${GOOGLE_DRIVE_FILE_FIELDS})`);
  url.searchParams.set("q", `trashed = false and modifiedTime > '${windowStart}' and modifiedTime <= '${windowEnd}'`);
  if (cursor.drivePageToken) {
    url.searchParams.set("pageToken", cursor.drivePageToken);
  }
  const payload = (await providerJson(url.toString(), headers, signal)).body;
  const listedFiles = array(payload.files).map(record);
  if (listedFiles.length > DRIVE_ITEM_PAGE_SIZE) {
    throw new Error("Google Drive page exceeds the requested item limit.");
  }
  // Anyone can share a file with the account, so knowledge reads only files
  // the account owns, and a shared file is never downloaded or parsed. The
  // query does not filter by owner because Drive documents owner queries only
  // by email address.
  const files = listedFiles.filter((file) => file.ownedByMe === true);
  const items = await Promise.all(files.map((file) =>
    googleDriveItem(file, headers, signal, identity)
  ));
  const nextPageToken = optionalProviderString(payload.nextPageToken);
  return {
    items: items.filter((item) => item.id),
    ...(cursor.drivePageToken ? {} : { relisted: true as const }),
    cursor: nextPageToken
      ? {
          driveModifiedAfter: cursor.driveModifiedAfter,
          drivePageToken: nextPageToken,
          driveWindowStart: windowStart,
          driveWindowEnd: windowEnd,
          driveChangesFence: fence,
          // A listing that replaces a rejected change position must not
          // leave that position behind for the next page to read.
          driveChangesStartPageToken: undefined,
          driveChangesPageToken: undefined,
        }
      : fence
        ? {
            driveModifiedAfter: undefined,
            drivePageToken: undefined,
            driveWindowStart: undefined,
            driveWindowEnd: undefined,
            driveChangesFence: undefined,
            driveChangesStartPageToken: fence,
            driveChangesPageToken: undefined,
          }
        : {
            driveModifiedAfter: windowEnd,
            drivePageToken: undefined,
            driveWindowStart: undefined,
            driveWindowEnd: undefined,
          },
  };
}

async function googleDriveStartPageToken(
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  const token = optionalProviderString((await providerJson(
    "https://www.googleapis.com/drive/v3/changes/startPageToken",
    headers,
    signal,
  )).body.startPageToken);
  if (!token) throw new Error("Google Drive returned no change position.");
  return token;
}

async function googleDriveChanges(
  headers: Record<string, string>,
  pageToken: string,
  signal?: AbortSignal,
  identity?: GoogleDriveSyncIdentity,
): Promise<GoogleSourcePage> {
  const url = new URL("https://www.googleapis.com/drive/v3/changes");
  url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("pageSize", String(DRIVE_ITEM_PAGE_SIZE));
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("includeRemoved", "true");
  url.searchParams.set("fields", `nextPageToken,newStartPageToken,changes(changeType,fileId,removed,file(${GOOGLE_DRIVE_FILE_FIELDS}))`);
  const response = await providerJson(url.toString(), headers, signal, [400, 410]);
  if (response.status === 400 || response.status === 410) {
    // Drive does not document how it rejects a change position. One it no
    // longer accepts starts a fresh listing, as Gmail and Calendar recover,
    // and any other bad request still fails the sync.
    if (response.status === 400 && !rejectsDrivePageToken(response.body)) {
      throw new Error("Connected source returned 400.");
    }
    return googleDrive(headers, {}, signal, identity);
  }
  const payload = response.body;
  const changes = array(payload.changes).map(record);
  if (changes.length > DRIVE_ITEM_PAGE_SIZE) {
    throw new Error("Google Drive change page exceeds the requested item limit.");
  }
  // A page without a position cannot advance the cursor, so it is rejected
  // before any of its files is exported or extracted.
  const nextPageToken = optionalProviderString(payload.nextPageToken);
  const newStartPageToken = optionalProviderString(payload.newStartPageToken);
  if (!nextPageToken && !newStartPageToken) {
    throw new Error("Google Drive returned no change position.");
  }
  // A page can report one file more than once, and its last change is the
  // file's current state.
  const latest = new Map<string, Record<string, unknown>>();
  for (const change of changes) {
    const fileId = String(change.fileId || "");
    if (change.changeType === "drive" || !fileId) continue;
    latest.set(fileId, change);
  }
  const items = await Promise.all([...latest].map(
    ([fileId, change]): SyncItem | Promise<SyncItem> => {
      const file = record(change.file);
      // Drive reports a deleted file, and one no longer shared with the
      // account, as removed. A trashed file, and one given to another owner,
      // leave knowledge as well.
      return change.removed === true || file.trashed === true ||
          file.ownedByMe !== true
        ? {
            id: fileId,
            kind: "drive",
            title: "Removed Drive file",
            content: "",
            excluded: true,
          }
        : googleDriveItem({ ...file, id: fileId }, headers, signal, identity);
    },
  ));
  return {
    items,
    cursor: nextPageToken
      ? {
          driveChangesPageToken: nextPageToken,
          driveChangesStartPageToken: undefined,
        }
      : {
          driveChangesPageToken: undefined,
          driveChangesStartPageToken: newStartPageToken,
        },
  };
}

function rejectsDrivePageToken(body: Record<string, unknown>) {
  return array(record(body.error).errors).some((error) =>
    record(error).location === "pageToken"
  );
}

async function googleDriveItem(
  file: Record<string, unknown>,
  headers: Record<string, string>,
  signal?: AbortSignal,
  identity?: GoogleDriveSyncIdentity,
): Promise<SyncItem> {
  const id = String(file.id || "");
  const mimeType = String(file.mimeType || "");
  const providerRevisionId = String(
    file.headRevisionId || file.version || file.modifiedTime || id,
  );
  const revisionMarker = googleDriveRevisionMarker(
    file,
    providerRevisionId,
  );
  const exportMime = mimeType === "application/vnd.google-apps.document"
    ? "text/plain"
    : mimeType === "application/vnd.google-apps.spreadsheet"
      ? "text/csv"
      : undefined;
  const download = downloadableDriveFile(
    mimeType,
    String(file.fileExtension || ""),
    Number(file.size || 0),
  );
  const reusableContent = id && identity && (exportMime || download)
    ? await reconstructCurrentGoogleDriveDocument({
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        idempotencyKey: `${identity.idempotencyPrefix}:drive:${id}`,
        revisionMarker,
        signal,
      })
    : undefined;
  let extracted = "";
  if (id && !reusableContent && exportMime) {
    const exportUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    try {
      extracted = (await providerText(exportUrl, headers, signal)).slice(0, 100_000);
    } catch {
      // A file can disappear or deny export after it was listed. Preserve
      // its useful metadata and let the next sync reconcile it.
    }
  }
  if (id && !reusableContent && !extracted) {
    if (download) {
      try {
        const bytes = await providerBytes(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, headers, signal, 5 * 1024 * 1024);
        const parsed = await extractCaptureFile(
          new File([bytes], `${String(file.name || "drive-file")}.${download.extension}`, { type: download.mimeType }),
          identity ? {
            tenantId: identity.tenantId,
            actorId: identity.actorId,
            sourceStreamId: `connector-sync:${identity.provider}:${identity.actorId}`,
            operation: "ocr",
            purpose: "connector.google.drive.extract",
            credentialSource: "deployment_environment",
          } : undefined,
        );
        extracted = parsed.content.slice(0, 100_000);
      } catch {
        // Metadata remains useful when a Drive binary cannot be extracted.
      }
    }
  }
  const sourceCreatedAt = optionalCanonicalProviderTimestamp(file.createdTime);
  const sourceUpdatedAt = canonicalProviderTimestamp(
    file.modifiedTime,
    "Drive modifiedTime",
  );
  return {
    id,
    kind: "drive",
    title: String(file.name || "Google Drive file"),
    providerRevisionId,
    sourceCreatedAt,
    sourceUpdatedAt,
    capturedAt: sourceUpdatedAt,
    metadata: {
      [GOOGLE_DRIVE_REVISION_MARKER_KEY]: revisionMarker,
    },
    content: reusableContent || googleDriveDocumentContent(file, extracted),
  };
}

function googleDriveRevisionMarker(
  file: Record<string, unknown>,
  providerRevisionId: string,
): GoogleDriveRevisionMarker {
  // The digest covers every provider field used to construct the normalized
  // document, not only Drive's binary head. A rename or description change
  // must therefore miss the preflight even if headRevisionId is unchanged.
  return Object.freeze({
    schemaVersion: GOOGLE_DRIVE_REVISION_MARKER_VERSION,
    snapshotSha256: sourceContractSha256({
      providerRevisionId,
      id: String(file.id || ""),
      name: String(file.name || ""),
      mimeType: String(file.mimeType || ""),
      createdTime: String(file.createdTime || ""),
      modifiedTime: String(file.modifiedTime || ""),
      version: String(file.version || ""),
      headRevisionId: String(file.headRevisionId || ""),
      webViewLink: String(file.webViewLink || ""),
      description: String(file.description || ""),
      size: String(file.size || ""),
      fileExtension: String(file.fileExtension || ""),
    }),
  });
}

function googleDriveDocumentContent(
  file: Record<string, unknown>,
  extracted: string,
) {
  return [
    `File: ${String(file.name || "Untitled")}`,
    `Type: ${String(file.mimeType || "")}`,
    `Modified: ${String(file.modifiedTime || "")}`,
    `Link: ${String(file.webViewLink || "")}`,
    `Description: ${String(file.description || "")}`,
    extracted ? `Content:\n${extracted}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Recovers an exact current Drive document before provider export/download or
 * OCR. The actor-owned cognition read is the authorization boundary. The
 * second canonical read supplies immutable locators only; every row must still
 * match that authorized document, current revision, and evidence identity.
 */
async function reconstructCurrentGoogleDriveDocument(input: {
  tenantId: string;
  actorId: string;
  idempotencyKey: string;
  revisionMarker: GoogleDriveRevisionMarker;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  try {
    input.signal?.throwIfAborted();
    const document = await getKnowledgeDocumentByIdempotencyKey(
      input.idempotencyKey,
      { tenantId: input.tenantId },
    );
    input.signal?.throwIfAborted();
    if (
      !document ||
      !googleDriveRevisionMarkerMatches(
        document.metadata,
        input.revisionMarker,
      )
    ) return undefined;

    const source = await getActorOwnedKnowledgeForCognition({
      tenantId: input.tenantId,
      actorId: input.actorId,
      documentId: document.id,
    });
    input.signal?.throwIfAborted();
    if (
      !source ||
      source.document.id !== document.id ||
      source.chunks.length < 1 ||
      source.chunks.length > GOOGLE_DRIVE_REUSE_MAX_CHUNKS ||
      source.document.chunkCount !== source.chunks.length
    ) return undefined;

    const canonical = await getCanonicalKnowledgeEvidenceByChunkIds(
      source.chunks.map((chunk) => chunk.id),
      { tenantId: input.tenantId },
    );
    input.signal?.throwIfAborted();
    if (canonical.length !== source.chunks.length) return undefined;

    const observedAt = new Date().toISOString();
    let containerLength: number | undefined;
    let containerSha256: string | undefined;
    let reconstructed = "";
    let coveredUntil = 0;
    for (const [index, authorizedChunk] of source.chunks.entries()) {
      const candidate = canonical[index];
      const evidence = candidate?.evidenceUnit;
      const locator = evidence?.locator;
      if (
        !candidate ||
        !evidence ||
        !locator ||
        candidate.chunk.id !== authorizedChunk.id ||
        candidate.chunk.chunkIndex !== index ||
        candidate.chunk.content !== authorizedChunk.content ||
        candidate.chunk.sourceRevisionId !== source.sourceRevisionId ||
        candidate.chunk.evidenceUnitId !== authorizedChunk.evidenceUnitId ||
        evidence.evidenceUnitId !== authorizedChunk.evidenceUnitId ||
        evidence.tenantId !== input.tenantId ||
        evidence.ownerActorId !== input.actorId ||
        evidence.visibility !== "user_private" ||
        !evidence.allowedPurposeIds.includes(KNOWLEDGE_COGNIFY_PURPOSE_ID) ||
        evidence.sourceItemId !== source.sourceItemId ||
        evidence.sourceRevisionId !== source.sourceRevisionId ||
        evidence.capturedAt > observedAt ||
        evidence.extractedAt > observedAt ||
        (evidence.retentionExpiresAt !== null &&
          evidence.retentionExpiresAt <= observedAt) ||
        !candidate.sourceState.isCurrent ||
        candidate.sourceState.operation !== "upsert" ||
        locator.kind !== "text_span" ||
        locator.offsetUnit !== "utf16_code_unit"
      ) return undefined;

      containerLength ??= locator.containerLength;
      containerSha256 ??= locator.containerSha256;
      if (
        locator.containerLength !== containerLength ||
        locator.containerSha256 !== containerSha256 ||
        locator.endOffsetExclusive <= coveredUntil ||
        locator.endOffsetExclusive - locator.startOffset !==
          authorizedChunk.content.length
      ) return undefined;
      if (locator.startOffset > coveredUntil) {
        // A two-character paragraph delimiter is the only legal uncovered
        // region emitted by the canonical normalizer/chunker.
        if (
          index === 0 ||
          locator.startOffset !== coveredUntil + 2 ||
          locator.endOffsetExclusive <= locator.startOffset
        ) return undefined;
        reconstructed += "\n\n";
        coveredUntil += 2;
      }

      const overlap = coveredUntil - locator.startOffset;
      if (
        overlap < 0 ||
        overlap >= authorizedChunk.content.length ||
        reconstructed.slice(locator.startOffset, coveredUntil) !==
          authorizedChunk.content.slice(0, overlap)
      ) return undefined;
      reconstructed += authorizedChunk.content.slice(overlap);
      coveredUntil = locator.endOffsetExclusive;
    }

    if (
      containerLength === undefined ||
      containerSha256 === undefined ||
      coveredUntil !== containerLength ||
      reconstructed.length !== containerLength ||
      normalizeTextForChunking(reconstructed) !== reconstructed ||
      contentSha256Hex(reconstructed) !== containerSha256 ||
      source.document.totalCharacters !== containerLength ||
      source.document.contentHash !== containerSha256
    ) return undefined;
    return reconstructed;
  } catch (error) {
    if (isPersonalSyncInterruption(error, input.signal)) throw error;
    // Missing, legacy, incomplete, unauthorized, or corrupt proof must never
    // become a cache hit. The normal provider fetch/extraction path remains
    // authoritative and will reconcile the document.
    return undefined;
  }
}

function googleDriveRevisionMarkerMatches(
  metadata: Record<string, unknown>,
  expected: GoogleDriveRevisionMarker,
) {
  const stored = record(metadata[GOOGLE_DRIVE_REVISION_MARKER_KEY]);
  return stored.schemaVersion === expected.schemaVersion &&
    stored.snapshotSha256 === expected.snapshotSha256;
}

function googleMessage(value: Record<string, unknown>): SyncItem {
  const headers = array(record(value.payload).headers).map(record);
  const header = (name: string) => String(headers.find((item) => String(item.name).toLowerCase() === name.toLowerCase())?.value || "");
  const payload = record(value.payload);
  const body = gmailText(payload).slice(0, 100_000);
  const attachments = gmailAttachments(payload);
  const observedAt = canonicalProviderEpochMilliseconds(
    value.internalDate,
    "Gmail internalDate",
  );
  const labelIds = array(value.labelIds).map(String);
  const fromAddress = header("From") || "unknown";
  const toAddress = header("To") || header("Delivered-To") || "unknown";
  const subject = header("Subject");
  const providerMessageId = String(value.id || "");
  const externalThreadId = String(value.threadId || "");
  return {
    id: providerMessageId,
    kind: "mail",
    title: header("Subject") || "Email",
    providerRevisionId: String(value.historyId || value.internalDate || value.id),
    sourceCreatedAt: observedAt,
    sourceUpdatedAt: observedAt,
    capturedAt: observedAt,
    content: [`Subject: ${subject}`, `From: ${fromAddress}`, `To: ${toAddress}`, `Cc: ${header("Cc")}`, `Date: ${header("Date")}`, `Labels: ${labelIds.join(", ")}`, body ? `Body:\n${body}` : `Snippet: ${String(value.snippet || "")}`, attachments.length ? `Attachments:\n${attachments.join("\n")}` : ""].filter(Boolean).join("\n"),
    ...(
      providerMessageId && externalThreadId && !labelIds.includes("SENT")
        ? {
            communication: {
              provider: "gmail" as const,
              providerMessageId,
              externalThreadId,
              fromAddress,
              toAddress,
              subject,
              content: body || String(value.snippet || ""),
              receivedAt: observedAt,
            },
          }
        : {}
    ),
  };
}
function googleEvent(value: Record<string, unknown>): SyncItem {
  const start = record(value.start);
  const end = record(value.end);
  const organizer = record(value.organizer);
  const conference = record(value.conferenceData);
  const deleted = value.status === "cancelled";
  const sourceCreatedAt = optionalCanonicalProviderTimestamp(value.created);
  const sourceUpdatedAt = value.updated
    ? canonicalProviderTimestamp(value.updated, "Calendar updated")
    : undefined;
  if (!deleted && !sourceUpdatedAt) {
    throw new Error("Google Calendar item is missing a canonical updated timestamp.");
  }
  const description = String(value.description || "").slice(0, 100_000);
  return {
    id: String(value.id),
    kind: "calendar",
    title: String(value.summary || "Calendar event"),
    deleted,
    providerRevisionId: String(value.etag || value.updated || value.id),
    sourceCreatedAt,
    sourceUpdatedAt,
    capturedAt: sourceUpdatedAt,
    calendarEvent: deleted ? undefined : {
      eventId: String(value.id),
      title: String(value.summary || "Calendar event"),
      description,
      status: String(value.status || "confirmed"),
      start: String(start.dateTime || start.date || ""),
      end: String(end.dateTime || end.date || ""),
      timezone: String(start.timeZone || end.timeZone || "UTC"),
      location: String(value.location || ""),
      organizer: calendarPerson(organizer, "organizer"),
      attendees: array(value.attendees).map((item) =>
        calendarPerson(record(item), "required")
      ),
    },
    content: [`Event: ${String(value.summary || "Untitled")}`, `Status: ${String(value.status || "")}`, `Start: ${String(start.dateTime || start.date || "")}`, `End: ${String(end.dateTime || end.date || "")}`, `Timezone: ${String(start.timeZone || end.timeZone || "")}`, `Location: ${String(value.location || "")}`, `Organizer: ${String(organizer.email || "")}`, `Meeting: ${String(value.hangoutLink || conference.conferenceId || "")}`, `Recurrence: ${array(value.recurrence).map(String).join("; ")}`, `Description: ${description}`, `Attendees: ${array(value.attendees).map((item) => { const attendee = record(item); return `${String(attendee.email || "")} (${String(attendee.responseStatus || "unknown")})`; }).filter(Boolean).join(", ")}`].join("\n"),
  };
}

function calendarPerson(
  value: Record<string, unknown>,
  role: "organizer" | "required",
) {
  return {
    email: String(value.email || ""),
    displayName: String(value.displayName || value.email || (role === "organizer" ? "Organizer" : "Attendee")),
    role,
    responseStatus: String(value.responseStatus || (role === "organizer" ? "accepted" : "unknown")),
    optional: Boolean(value.optional),
  };
}

async function providerJson(url: string, headers: Record<string, string>, signal?: AbortSignal, accepted: number[] = []) { return withProviderDeadline(signal, async (requestSignal) => { const response = await fetch(url, { headers, signal: requestSignal }); const body = await response.json().catch((error: unknown) => { if (requestSignal.aborted) throw error; return {}; }) as Record<string, unknown>; if (!response.ok && !accepted.includes(response.status)) throw new Error(`Connected source returned ${response.status}.`); return { status: response.status, body }; }); }
async function providerText(url: string, headers: Record<string, string>, signal?: AbortSignal) { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.hostname !== "www.googleapis.com") throw new Error("Provider returned an unsafe document URL."); return withProviderDeadline(signal, async (requestSignal) => { const response = await fetch(url, { headers, signal: requestSignal }); if (!response.ok) throw new Error(`Connected source returned ${response.status}.`); return (await readResponseTextLimited(response, DRIVE_EXPORT_READ_BYTES)).text; }); }
async function providerBytes(url: string, headers: Record<string, string>, signal: AbortSignal | undefined, maxBytes: number) { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.hostname !== "www.googleapis.com") throw new Error("Provider returned an unsafe document URL."); return withProviderDeadline(signal, async (requestSignal) => { const response = await fetch(url, { headers, signal: requestSignal }); if (!response.ok) throw new Error(`Connected source returned ${response.status}.`); const declared = Number(response.headers.get("content-length") || 0); if (declared > maxBytes) throw new Error("Connected file exceeds the extraction limit."); const body = await readResponseBytesLimited(response, maxBytes); if (body.truncated) throw new Error("Connected file exceeds the extraction limit."); return body.bytes; }); }

/**
 * Runs one provider request, body included, under the caller's signal and a
 * time limit of its own. A request past the limit fails as a timeout, which
 * counts against the source; the caller's abort still interrupts the sync.
 */
async function withProviderDeadline<T>(
  signal: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
) {
  await nativePersonalExecution.getStore()?.beforeProvider();
  const deadline = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  try {
    return await request(signal ? AbortSignal.any([signal, deadline]) : deadline);
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) {
      throw new Error("Connected source timed out.");
    }
    throw error;
  }
}

function personalSyncCorrelationId(input: {
  tenantId: string;
  actorId: string;
  connectionId: string;
  authorizationGeneration: number;
}) {
  return `google-personal-sync:${sourceContractSha256({
    schemaVersion: 1,
    tenantId: input.tenantId,
    actorId: input.actorId,
    connectionId: input.connectionId,
    authorizationGeneration: input.authorizationGeneration,
  }).slice(0, 40)}`;
}

function isReplaceableKnowledgeConflict(error: unknown) {
  if (!(error instanceof Error)) return false;
  return [
    "Knowledge document idempotency key is already bound to different content.",
    "Knowledge document idempotency key is already bound to different chunks.",
    "Knowledge document ID is already bound to different source lineage.",
  ].includes(error.message);
}
function gmailText(payload: Record<string, unknown>): string { const ownType = String(payload.mimeType || ""); const ownData = String(record(payload.body).data || ""); if (ownData && (ownType === "text/plain" || ownType === "text/html")) return ownType === "text/html" ? stripHtml(decodeBase64Url(ownData)) : decodeBase64Url(ownData); const parts = array(payload.parts).map(record); const plain = parts.flatMap((part) => gmailParts(part, "text/plain")); if (plain.length) return plain.join("\n\n"); return parts.flatMap((part) => gmailParts(part, "text/html")).map(stripHtml).join("\n\n"); }
function gmailParts(part: Record<string, unknown>, mimeType: string): string[] { const nested = array(part.parts).map(record).flatMap((child) => gmailParts(child, mimeType)); const data = String(record(part.body).data || ""); return String(part.mimeType || "") === mimeType && data ? [decodeBase64Url(data), ...nested] : nested; }
function gmailAttachments(payload: Record<string, unknown>): string[] { return array(payload.parts).map(record).flatMap((part) => { const nested = gmailAttachments(part); const filename = String(part.filename || "").trim(); const body = record(part.body); return filename ? [`- ${filename} · ${String(part.mimeType || "file")} · ${Number(body.size || 0)} bytes`, ...nested] : nested; }); }
function decodeBase64Url(value: string) { try { return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim(); } catch { return ""; } }
function stripHtml(value: string) { return value.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(); }
function downloadableDriveFile(mimeType: string, extension: string, size: number) {
  if (size > 5 * 1024 * 1024) return undefined;
  const normalizedExtension = extension.trim().toLowerCase();
  const knownMimeTypes: Record<string, string> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.presentation": "odp",
    "application/epub+zip": "epub",
    "application/rtf": "rtf",
    "message/rfc822": "eml",
    "text/calendar": "ics",
    "text/vcard": "vcf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const inferred = knownMimeTypes[mimeType];
  if (inferred) return { extension: inferred, mimeType };
  if (mimeType.startsWith("text/")) return { extension: normalizedExtension || "txt", mimeType };
  return undefined;
}
function parseCursor(value?: string): SyncCursor { if (!value) return {}; try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed as SyncCursor : {}; } catch { return {}; } }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function unique(values: string[]) { return [...new Set(values)]; }

function hasExcludedGmailLabel(labelIds: unknown) {
  return array(labelIds).some((labelId) =>
    typeof labelId === "string" && GMAIL_EXCLUDED_LABEL_IDS.has(labelId)
  );
}

function googleCursorIds(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Stored Gmail continuation items are invalid.");
  }
  return googleProviderIds(value);
}

function googleProviderIds(values: unknown[]) {
  const ids = unique(values.map(String).filter(Boolean));
  if (
    ids.length > GMAIL_PENDING_ITEM_LIMIT ||
    ids.some((item) => !/^[A-Za-z0-9_-]{1,256}$/.test(item))
  ) {
    throw new Error("Google returned invalid or excessive item identifiers.");
  }
  return ids;
}

function boundedGmailItems(addedIds: string[], deletedIds: string[]) {
  const deleted = unique(deletedIds);
  const deletedSet = new Set(deleted);
  const added = unique(addedIds).filter((id) => !deletedSet.has(id));
  const page = [
    ...added.map((id) => ({ id, deleted: false })),
    ...deleted.map((id) => ({ id, deleted: true })),
  ];
  const selected = page.slice(0, GMAIL_ITEM_PAGE_SIZE);
  const remaining = page.slice(GMAIL_ITEM_PAGE_SIZE);
  return {
    addedIds: selected.filter((item) => !item.deleted).map((item) => item.id),
    deletedIds: selected.filter((item) => item.deleted).map((item) => item.id),
    remainingAddedIds: remaining
      .filter((item) => !item.deleted)
      .map((item) => item.id),
    remainingDeletedIds: remaining
      .filter((item) => item.deleted)
      .map((item) => item.id),
  };
}

function gmailHistoryContinuationCursor(input: {
  historyId: string;
  pendingHistoryId: string;
  nextPageToken?: string;
  remainingAddedIds: string[];
  remainingDeletedIds: string[];
}): Partial<SyncCursor> {
  if (
    input.remainingAddedIds.length ||
    input.remainingDeletedIds.length ||
    input.nextPageToken
  ) {
    return {
      gmailHistoryId: input.historyId,
      gmailPageToken: input.nextPageToken,
      gmailPendingHistoryId: input.pendingHistoryId,
      gmailPendingAddedIds: input.remainingAddedIds.length
        ? input.remainingAddedIds
        : undefined,
      gmailPendingDeletedIds: input.remainingDeletedIds.length
        ? input.remainingDeletedIds
        : undefined,
      gmailBackfillPageToken: undefined,
      gmailBackfillHistoryId: undefined,
    };
  }
  return {
    gmailHistoryId: input.pendingHistoryId,
    gmailPageToken: undefined,
    gmailPendingHistoryId: undefined,
    gmailPendingAddedIds: undefined,
    gmailPendingDeletedIds: undefined,
    gmailBackfillPageToken: undefined,
    gmailBackfillHistoryId: undefined,
  };
}

function optionalProviderString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (text.length > 8_000 || /[\u0000-\u001f]/.test(text)) {
    throw new Error("Google returned an invalid pagination token.");
  }
  return text;
}

function canonicalProviderEpochMilliseconds(value: unknown, field: string) {
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error(`Google ${field} is invalid.`);
  }
  return canonicalProviderTimestamp(milliseconds, field);
}

function canonicalProviderTimestamp(value: unknown, field: string) {
  const timestamp = new Date(
    typeof value === "number" ? value : String(value || ""),
  );
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`Google ${field} is invalid.`);
  }
  return timestamp.toISOString();
}

function optionalCanonicalProviderTimestamp(value: unknown) {
  return value === null || value === undefined || value === ""
    ? undefined
    : canonicalProviderTimestamp(value, "provider timestamp");
}

function googleSourceBackfillState(
  source: PersonalSourceId,
  cursor: Partial<SyncCursor>,
): OAuthSourceCoverageCheckpoint["backfillState"] {
  if (source === "mail") {
    if (
      cursor.gmailBackfillPageToken ||
      cursor.gmailPageToken ||
      cursor.gmailPendingAddedIds?.length ||
      cursor.gmailPendingDeletedIds?.length
    ) return "in_progress";
    return cursor.gmailHistoryId ? "complete" : "unknown";
  }
  if (source === "calendar") {
    if (cursor.calendarPageToken) return "in_progress";
    return cursor.calendar ? "complete" : "unknown";
  }
  if (cursor.drivePageToken || cursor.driveChangesPageToken) {
    return "in_progress";
  }
  return cursor.driveModifiedAfter || cursor.driveChangesStartPageToken
    ? "complete"
    : "unknown";
}

function personalSourceFailureCode(
  error: unknown,
): NonNullable<OAuthSourceCoverageCheckpoint["failureCode"]> {
  if (error instanceof OAuthProviderError) {
    if (error.code === "provider_rate_limited") return "provider_rate_limited";
    if (error.code === "provider_unavailable") return "provider_unavailable";
    return "provider_unauthorized";
  }
  if (error instanceof OAuthCredentialError) {
    return error.code === "capability_not_granted"
      ? "provider_forbidden"
      : "provider_unauthorized";
  }
  const message = error instanceof Error ? error.message : "";
  if (/\b401\b|unauthori[sz]ed|access expired/i.test(message)) {
    return "provider_unauthorized";
  }
  if (/\b403\b|forbidden|permission/i.test(message)) {
    return "provider_forbidden";
  }
  if (/\b429\b|rate limit/i.test(message)) {
    return "provider_rate_limited";
  }
  if (/\b5\d\d\b|unavailable|timeout|timed out/i.test(message)) {
    return "provider_unavailable";
  }
  return "processing_failed";
}

/** The cursor with one source's set-aside items, which it omits when none. */
function withSourceItemQuarantine(
  cursor: SyncCursor,
  source: PersonalSourceId,
  state: SourceItemQuarantine,
): SyncCursor {
  const value = sourceItemQuarantineValue(state);
  const itemQuarantine = { ...record(cursor.itemQuarantine) };
  if (value) itemQuarantine[source] = value;
  else delete itemQuarantine[source];
  return {
    ...cursor,
    itemQuarantine: Object.keys(itemQuarantine).length
      ? itemQuarantine
      : undefined,
  };
}

/** The cursor with one source's document sweep, which it omits when none. */
function withSourceDocumentSweep(
  cursor: SyncCursor,
  source: PersonalSourceId,
  sweep: SourceDocumentSweep | undefined,
): SyncCursor {
  const documentSweep = { ...record(cursor.documentSweep) };
  if (sweep) documentSweep[source] = sweep;
  else delete documentSweep[source];
  return {
    ...cursor,
    documentSweep: Object.keys(documentSweep).length
      ? documentSweep
      : undefined,
  };
}

/**
 * Where a cursor stands in its sources, apart from the items set aside and
 * the documents being checked again.
 */
function sourcePosition(cursor: SyncCursor) {
  return JSON.stringify({
    ...cursor,
    itemQuarantine: undefined,
    documentSweep: undefined,
  });
}

/**
 * The record of a document sweep that finished, or stopped before removing
 * what it found gone. It carries counts only.
 */
function sourceSweepEvent(
  type: "finished" | "stopped",
  connectionId: string,
  source: PersonalSourceId,
  sweep: SourceDocumentSweep,
  detail: Readonly<Record<string, number>>,
): SourceItemEvent {
  const adapter = GOOGLE_SOURCE_ADAPTERS[source];
  return {
    id: `source_sweep_event_${sourceContractSha256({
      schemaVersion: 1,
      connectionId,
      source,
      since: sweep.since,
      type,
    }).slice(0, 56)}`,
    streamId: `connector:${connectionId}`,
    type: `connector.source_sweep.${type}`,
    payload: {
      schemaVersion: 1,
      connectionId,
      source,
      adapterId: adapter.adapterId,
      adapterVersionId: adapter.adapterVersionId,
      checked: sweep.checked,
      removed: sweep.removed,
      ...detail,
    },
  };
}

/**
 * The record of a set-aside decision. It names the item only by a digest,
 * and carries no provider text and no error.
 */
function sourceItemEvent(
  type: "quarantined" | "released",
  connectionId: string,
  source: PersonalSourceId,
  item: QuarantinedSourceItem,
  detail: Readonly<Record<string, string | number>>,
): SourceItemEvent {
  const adapter = GOOGLE_SOURCE_ADAPTERS[source];
  const itemSha256 = sourceContractSha256({
    schemaVersion: 1,
    connectionId,
    externalItemId: `${source}:${item.id}`,
  });
  return {
    id: `source_item_event_${sourceContractSha256({
      schemaVersion: 1,
      connectionId,
      itemSha256,
      since: item.since,
      type,
    }).slice(0, 56)}`,
    streamId: `connector:${connectionId}`,
    type: `connector.source_item.${type}`,
    payload: {
      schemaVersion: 1,
      connectionId,
      source,
      adapterId: adapter.adapterId,
      adapterVersionId: adapter.adapterVersionId,
      itemSha256,
      ...detail,
    },
  };
}

function isPersonalSyncInterruption(
  error: unknown,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}

function safeSourceSyncError(error: unknown) {
  const message = error instanceof Error ? error.message : "Source sync failed.";
  return message.replace(/[\r\n<>]/g, " ").slice(0, 500);
}
