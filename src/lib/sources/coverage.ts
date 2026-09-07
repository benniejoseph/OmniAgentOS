import { z } from "zod";

import type { RequestOAuthGrant } from "@/lib/connectors/oauth-store";
import type { TruthfulIntegrationsOverview } from "@/lib/connectors/truthful-overview";

export const SOURCE_COVERAGE_VERSION = "p11.9-source-coverage:1" as const;

const timestampSchema = z.string().datetime({ offset: true });
const sourceStateSchema = z.object({
  state: z.enum(["ready", "unavailable"]),
  detail: z.string().min(1).max(300),
}).strict();

const domainSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  category: z.enum([
    "communication", "schedule", "files", "media", "customer",
    "knowledge", "productivity", "location", "health", "finance",
    "commerce", "travel", "social", "home",
  ]),
  availability: z.enum([
    "connected", "native", "available_not_connected", "unsupported", "unavailable",
  ]),
  coverage: z.object({
    state: z.enum(["complete", "partial", "none", "not_applicable", "unknown"]),
    observedItems: z.number().int().nonnegative().nullable(),
    detail: z.string().min(1).max(500),
  }).strict(),
  backfill: z.object({
    state: z.enum(["complete", "in_progress", "not_started", "not_applicable", "unknown"]),
    detail: z.string().min(1).max(500),
  }).strict(),
  freshness: z.object({
    state: z.enum(["current", "stale", "never", "not_applicable", "unknown"]),
    lastVerifiedAt: timestampSchema.nullable(),
    staleAfterSeconds: z.number().int().nonnegative().nullable(),
  }).strict(),
  blindSpot: z.boolean(),
  limitation: z.string().min(1).max(500),
  nextAction: z.object({
    state: z.enum(["none", "available", "action_required", "unsupported"]),
    label: z.string().min(1).max(300),
    href: z.string().startsWith("/app/").max(240).nullable(),
  }).strict(),
}).strict();

export const sourceCoverageProjectionSchema = z.object({
  version: z.literal(SOURCE_COVERAGE_VERSION),
  generatedAt: timestampSchema,
  state: z.enum(["ready", "partial"]),
  disclosure: z.object({
    absenceInference: z.literal("forbidden"),
    rawCursorValuesIncluded: z.literal(false),
    providerContentIncluded: z.literal(false),
    actorCoordinatesIncluded: z.literal(false),
  }).strict(),
  inventory: z.object({
    integrations: sourceStateSchema,
    oauth: sourceStateSchema,
    ownedSources: sourceStateSchema,
  }).strict(),
  summary: z.object({
    connectedDomains: z.number().int().nonnegative(),
    completeDomains: z.number().int().nonnegative(),
    staleDomains: z.number().int().nonnegative(),
    blindSpots: z.number().int().nonnegative(),
    unknownDomains: z.number().int().nonnegative(),
    lastVerifiedAt: timestampSchema.nullable(),
  }).strict(),
  knowledgeIndex: z.object({
    state: z.enum(["complete", "partial", "empty", "unknown"]),
    sourceItems: z.number().int().nonnegative().nullable(),
    indexedDocuments: z.number().int().nonnegative().nullable(),
    chunks: z.number().int().nonnegative().nullable(),
    embeddedChunks: z.number().int().nonnegative().nullable(),
    lastIndexedAt: timestampSchema.nullable(),
    detail: z.string().min(1).max(500),
  }).strict(),
  domains: z.array(domainSchema).min(1).max(40),
}).strict();

export type SourceCoverageProjection = z.infer<typeof sourceCoverageProjectionSchema>;
export type SourceCoverageDomain = SourceCoverageProjection["domains"][number];

export type SourceCoverageDependency<T> =
  | Readonly<{ state: "ready"; value: T }>
  | Readonly<{ state: "unavailable"; detail: string }>;

export type OwnedSourceCoverageInventory = Readonly<{
  domains: readonly Readonly<{
    id: "gmail" | "google_calendar" | "google_drive" | "capture" | "knowledge_uploads" | "other";
    currentItems: number;
    lastObservedAt: string | null;
  }>[];
  knowledgeIndex: Readonly<{
    sourceItems: number;
    indexedDocuments: number;
    chunks: number;
    embeddedChunks: number;
    lastIndexedAt: string | null;
  }>;
  capture: Readonly<{
    total: number;
    indexed: number;
    pending: number;
    failed: number;
    lastUpdatedAt: string | null;
  }>;
}>;

export type SourceCoverageInput = Readonly<{
  integrations: SourceCoverageDependency<TruthfulIntegrationsOverview>;
  oauth: SourceCoverageDependency<readonly RequestOAuthGrant[]>;
  ownedSources: SourceCoverageDependency<OwnedSourceCoverageInventory>;
  generatedAt?: string;
}>;

const GOOGLE_STALE_AFTER_SECONDS = 2 * 60 * 60;
const NATIVE_STALE_AFTER_SECONDS = 30 * 24 * 60 * 60;

const unsupportedDomains = Object.freeze([
  ["contacts", "Contacts", "productivity", "No native Contacts source is installed."],
  ["tasks_notes", "Tasks and notes", "productivity", "Google Tasks, Keep, and equivalent task or note history are not connected."],
  ["location", "Maps and location", "location", "Location history is unsupported and Asael cannot assess where you have been."],
  ["youtube", "YouTube history", "media", "Watch and search history are unsupported."],
  ["microsoft_365", "Microsoft 365", "productivity", "Outlook, OneDrive, Teams, and Microsoft Graph are not installed."],
  ["apple_icloud", "Apple and iCloud", "productivity", "iCloud Mail, Calendar, Drive, Notes, and Reminders are not installed."],
  ["messages_calls", "Messages and calls", "communication", "Phone, SMS, and messaging history are not connected."],
  ["health_wearables", "Health and wearables", "health", "Health and wearable data are unsupported."],
  ["finance", "Finance", "finance", "Banking and investment data are unsupported."],
  ["purchases", "Purchases", "commerce", "Purchase and receipt history are not connected."],
  ["travel", "Travel", "travel", "Travel providers and itinerary history are not connected."],
  ["social", "Social networks", "social", "Social-network activity is unsupported."],
  ["smart_home", "Smart home", "home", "Smart-home activity is unsupported."],
] as const);

export function projectSourceCoverage(input: SourceCoverageInput): SourceCoverageProjection {
  const generatedAt = canonicalTimestamp(input.generatedAt || new Date().toISOString());
  const domains: SourceCoverageDomain[] = [
    googleDomain(input, generatedAt, {
      id: "gmail", label: "Gmail", category: "communication", integrationId: "google:gmail", sourceId: "mail",
    }),
    googleDomain(input, generatedAt, {
      id: "google_calendar", label: "Google Calendar", category: "schedule", integrationId: "google:google-calendar", sourceId: "calendar",
    }),
    googleDomain(input, generatedAt, {
      id: "google_drive", label: "Google Drive", category: "files", integrationId: "google:google-drive", sourceId: "drive",
    }),
    pickerDomain(input, "google_photos", "Google Photos", "google:google-photos", "media"),
    salesforceDomain(input),
    nativeCaptureDomain(input, generatedAt),
    nativeKnowledgeDomain(input, generatedAt),
    ...unsupportedDomains.map(([id, label, category, limitation]) => unsupportedDomain(
      id,
      label,
      category,
      limitation,
    )),
  ];
  const lastVerifiedAt = newestTimestamp(domains.map((domain) => domain.freshness.lastVerifiedAt));
  const unknownDomains = domains.filter((domain) =>
    domain.availability === "unavailable" ||
    domain.coverage.state === "unknown" ||
    domain.freshness.state === "unknown"
  ).length;
  return sourceCoverageProjectionSchema.parse({
    version: SOURCE_COVERAGE_VERSION,
    generatedAt,
    state: [input.integrations, input.oauth, input.ownedSources]
      .some((source) => source.state === "unavailable") ? "partial" : "ready",
    disclosure: {
      absenceInference: "forbidden",
      rawCursorValuesIncluded: false,
      providerContentIncluded: false,
      actorCoordinatesIncluded: false,
    },
    inventory: {
      integrations: dependencyState(input.integrations, "Integration inventory is current."),
      oauth: dependencyState(input.oauth, "OAuth source checkpoints are current."),
      ownedSources: dependencyState(input.ownedSources, "Actor-owned source inventory is current."),
    },
    summary: {
      connectedDomains: domains.filter((domain) =>
        domain.availability === "connected" || domain.availability === "native"
      ).length,
      completeDomains: domains.filter((domain) => domain.coverage.state === "complete").length,
      staleDomains: domains.filter((domain) => domain.freshness.state === "stale").length,
      blindSpots: domains.filter((domain) => domain.blindSpot).length,
      unknownDomains,
      lastVerifiedAt,
    },
    knowledgeIndex: knowledgeIndex(input.ownedSources),
    domains,
  });
}

function googleDomain(
  input: SourceCoverageInput,
  generatedAt: string,
  spec: Readonly<{
    id: "gmail" | "google_calendar" | "google_drive";
    label: string;
    category: "communication" | "schedule" | "files";
    integrationId: string;
    sourceId: "mail" | "calendar" | "drive";
  }>,
): SourceCoverageDomain {
  if (input.integrations.state === "unavailable") {
    return unavailableDomain(spec.id, spec.label, spec.category, input.integrations.detail);
  }
  const integration = input.integrations.value.installed.find((item) => item.id === spec.integrationId);
  if (!integration) {
    return notConnectedDomain(spec.id, spec.label, spec.category, "Connect Google to establish source coverage.", "/app/connectors");
  }
  if (!integration.connected) {
    return notConnectedDomain(spec.id, spec.label, spec.category, integration.nextAction, integration.manageHref);
  }
  if (input.oauth.state === "unavailable") {
    return unavailableDomain(spec.id, spec.label, spec.category, input.oauth.detail, integration.manageHref);
  }
  const grant = input.oauth.value.find((item) => item.provider === "google");
  const checkpoint = grant?.sourceCoverage[spec.sourceId];
  const inventory = input.ownedSources.state === "ready"
    ? input.ownedSources.value.domains.find((domain) => domain.id === spec.id)
    : undefined;
  if (!checkpoint) {
    return {
      id: spec.id,
      label: spec.label,
      category: spec.category,
      availability: "connected",
      coverage: {
        state: "unknown",
        observedItems: inventory?.currentItems ?? null,
        detail: "Google is connected, but no source-specific P11.9 checkpoint exists yet. Provider-level history is not treated as per-source proof.",
      },
      backfill: { state: "unknown", detail: "Run the next Google sync to establish a source-specific backfill checkpoint." },
      freshness: { state: "unknown", lastVerifiedAt: null, staleAfterSeconds: GOOGLE_STALE_AFTER_SECONDS },
      blindSpot: true,
      limitation: "Until a granular checkpoint is recorded, Asael cannot prove this source's completeness or freshness.",
      nextAction: { state: "action_required", label: "Run Google sync now.", href: integration.manageHref },
    };
  }
  const verifiedFreshness = freshnessFrom(
    checkpoint.lastSuccessfulAt,
    GOOGLE_STALE_AFTER_SECONDS,
    generatedAt,
  );
  const freshness = checkpoint.status === "error"
    ? {
        state: "unknown" as const,
        lastVerifiedAt: verifiedFreshness.lastVerifiedAt,
        staleAfterSeconds: GOOGLE_STALE_AFTER_SECONDS,
      }
    : verifiedFreshness;
  const coverageState = checkpoint.backfillState === "complete"
    ? "complete" as const
    : checkpoint.backfillState === "in_progress"
      ? "partial" as const
      : "unknown" as const;
  const problem = checkpoint.status === "error" || freshness.state === "stale";
  return {
    id: spec.id,
    label: spec.label,
    category: spec.category,
    availability: "connected",
    coverage: {
      state: coverageState,
      observedItems: inventory?.currentItems ?? null,
      detail: checkpoint.backfillState === "complete"
        ? "The bounded backfill reached its delta checkpoint. Current item totals include only actor-owned canonical source heads."
        : checkpoint.backfillState === "in_progress"
          ? "The bounded backfill has more pages. Missing pages remain an explicit blind spot."
          : "Backfill completion has not been proven.",
    },
    backfill: {
      state: checkpoint.backfillState,
      detail: checkpoint.backfillState === "complete"
        ? "Initial history is complete and later runs continue from an incremental checkpoint."
        : checkpoint.backfillState === "in_progress"
          ? "A continuation page is safely checkpointed."
          : "No complete backfill boundary is recorded.",
    },
    freshness,
    blindSpot: coverageState !== "complete",
    limitation: checkpoint.status === "error"
      ? `The last attempt failed with ${failureLabel(checkpoint.failureCode)}; previously verified coverage is retained but not presented as current.`
      : freshness.state === "stale"
        ? "The last verified source checkpoint is older than the two-hour freshness target."
        : "Coverage is limited to the granted Google scope and configured backfill window.",
    nextAction: problem || coverageState !== "complete"
      ? { state: "action_required", label: integration.nextAction, href: integration.manageHref }
      : { state: "none", label: "No action required; monitor the next scheduled sync.", href: integration.manageHref },
  };
}

function pickerDomain(
  input: SourceCoverageInput,
  id: string,
  label: string,
  integrationId: string,
  category: SourceCoverageDomain["category"],
): SourceCoverageDomain {
  if (input.integrations.state === "unavailable") {
    return unavailableDomain(id, label, category, input.integrations.detail);
  }
  const integration = input.integrations.value.installed.find((item) => item.id === integrationId);
  if (!integration?.connected) {
    return notConnectedDomain(id, label, category, integration?.nextAction || `Connect ${label}.`, integration?.manageHref || "/app/connectors");
  }
  return {
    id,
    label,
    category,
    availability: "connected",
    coverage: { state: "not_applicable", observedItems: null, detail: "Photos enter Asael only after an explicit picker selection; no background library coverage is implied." },
    backfill: { state: "not_applicable", detail: "There is no automatic Photos backfill." },
    freshness: { state: "not_applicable", lastVerifiedAt: null, staleAfterSeconds: null },
    blindSpot: true,
    limitation: "Unselected photos remain unknown to Asael.",
    nextAction: { state: "available", label: "Select photos from Capture when they are needed.", href: "/app/capture" },
  };
}

function salesforceDomain(input: SourceCoverageInput): SourceCoverageDomain {
  if (input.integrations.state === "unavailable") {
    return unavailableDomain("salesforce", "Salesforce", "customer", input.integrations.detail, "/app/accounts");
  }
  const integration = input.integrations.value.installed.find((item) => item.id === "salesforce:workspace");
  if (!integration?.connected) {
    return notConnectedDomain("salesforce", "Salesforce", "customer", integration?.nextAction || "Connect Salesforce to a canonical Workspace.", "/app/accounts");
  }
  const coverage = integration.sync.coverage;
  const freshness = integration.sync.freshness.state === "current"
    ? "current" as const
    : integration.sync.freshness.state === "stale"
      ? "stale" as const
      : integration.sync.freshness.state === "never"
        ? "never" as const
        : "unknown" as const;
  return {
    id: "salesforce",
    label: "Salesforce",
    category: "customer",
    availability: "connected",
    coverage: { state: coverage, observedItems: null, detail: integration.sync.coverageDetail },
    backfill: {
      state: coverage === "complete" ? "complete" : coverage === "partial" ? "in_progress" : coverage === "none" ? "not_started" : "unknown",
      detail: integration.sync.cursor.detail,
    },
    freshness: {
      state: freshness,
      lastVerifiedAt: integration.sync.lastSuccessfulAt,
      staleAfterSeconds: integration.sync.freshness.staleAfterSeconds,
    },
    blindSpot: coverage !== "complete",
    limitation: coverage === "complete"
      ? "Coverage is limited to the configured Salesforce object scope and Workspace authority."
      : "Uncheckpointed Salesforce objects remain unknown and are not treated as absent records.",
    nextAction: {
      state: integration.state === "working" ? "none" : "action_required",
      label: integration.nextAction,
      href: integration.manageHref,
    },
  };
}

function nativeCaptureDomain(input: SourceCoverageInput, generatedAt: string): SourceCoverageDomain {
  if (input.ownedSources.state === "unavailable") {
    return unavailableDomain("capture", "Capture", "media", input.ownedSources.detail, "/app/capture");
  }
  const capture = input.ownedSources.value.capture;
  const observed = input.ownedSources.value.domains.find((item) => item.id === "capture");
  const observedItems = observed?.currentItems ?? 0;
  const inventoryConflict = capture.indexed !== observedItems;
  const state = inventoryConflict
    ? "unknown" as const
    : capture.total === 0
      ? "none" as const
      : capture.indexed === capture.total
        ? "complete" as const
        : "partial" as const;
  return {
    id: "capture",
    label: "Capture",
    category: "media",
    availability: "native",
    coverage: {
      state,
      observedItems,
      detail: inventoryConflict
        ? `Capture inventories disagree: ${capture.indexed} indexed submissions and ${observedItems} current canonical source heads. No complete or empty state is inferred.`
        : capture.total === 0
          ? "No actor-owned Capture submission is recorded. This says nothing about media that was never submitted."
        : `${capture.indexed}/${capture.total} submitted Capture items are indexed · ${capture.pending} pending · ${capture.failed} failed.`,
    },
    backfill: { state: "not_applicable", detail: "Capture indexes only items explicitly submitted by the actor." },
    freshness: freshnessFrom(observed?.lastObservedAt || null, NATIVE_STALE_AFTER_SECONDS, generatedAt, true),
    blindSpot: inventoryConflict || capture.pending > 0 || capture.failed > 0,
    limitation: "Files, scans, images, and meetings that were not submitted remain outside Asael's knowledge.",
    nextAction: inventoryConflict
      ? { state: "action_required", label: "Review Capture source inventory.", href: "/app/capture" }
      : capture.pending || capture.failed
        ? { state: "action_required", label: "Review pending or failed Capture processing.", href: "/app/capture" }
      : { state: "available", label: "Add a file, scan, image, or recording when needed.", href: "/app/capture" },
  };
}

function nativeKnowledgeDomain(input: SourceCoverageInput, generatedAt: string): SourceCoverageDomain {
  if (input.ownedSources.state === "unavailable") {
    return unavailableDomain("knowledge_uploads", "Direct knowledge", "knowledge", input.ownedSources.detail, "/app/memory");
  }
  const observed = input.ownedSources.value.domains.find((item) => item.id === "knowledge_uploads");
  const count = observed?.currentItems || 0;
  return {
    id: "knowledge_uploads",
    label: "Direct knowledge",
    category: "knowledge",
    availability: "native",
    coverage: {
      state: count ? "complete" : "none",
      observedItems: count,
      detail: count
        ? "Every displayed item has a current actor-owned canonical source head."
        : "No direct actor-owned knowledge import is recorded; unsubmitted knowledge remains unknown.",
    },
    backfill: { state: "not_applicable", detail: "Direct imports are indexed individually and have no external-history backfill." },
    freshness: freshnessFrom(observed?.lastObservedAt || null, NATIVE_STALE_AFTER_SECONDS, generatedAt, true),
    blindSpot: false,
    limitation: "This covers only explicitly submitted or restored knowledge, not information elsewhere.",
    nextAction: { state: "available", label: "Use Capture to add source material.", href: "/app/capture" },
  };
}

function unsupportedDomain(
  id: string,
  label: string,
  category: SourceCoverageDomain["category"],
  limitation: string,
): SourceCoverageDomain {
  return {
    id,
    label,
    category,
    availability: "unsupported",
    coverage: { state: "unknown", observedItems: null, detail: "No supported source contract exists, so the underlying domain is unknown." },
    backfill: { state: "not_applicable", detail: "Backfill cannot start until a governed source adapter exists." },
    freshness: { state: "unknown", lastVerifiedAt: null, staleAfterSeconds: null },
    blindSpot: true,
    limitation,
    nextAction: { state: "unsupported", label: "No supported connection is available yet.", href: null },
  };
}

function unavailableDomain(
  id: string,
  label: string,
  category: SourceCoverageDomain["category"],
  detail: string,
  href = "/app/connectors",
): SourceCoverageDomain {
  return {
    id,
    label,
    category,
    availability: "unavailable",
    coverage: { state: "unknown", observedItems: null, detail: safeText(detail) },
    backfill: { state: "unknown", detail: "Backfill state is unavailable and was not inferred." },
    freshness: { state: "unknown", lastVerifiedAt: null, staleAfterSeconds: null },
    blindSpot: true,
    limitation: "The inventory could not be read, so no connected, complete, or stale claim is made.",
    nextAction: { state: "action_required", label: "Retry the coverage read.", href },
  };
}

function notConnectedDomain(
  id: string,
  label: string,
  category: SourceCoverageDomain["category"],
  action: string,
  href: string,
): SourceCoverageDomain {
  return {
    id,
    label,
    category,
    availability: "available_not_connected",
    coverage: { state: "unknown", observedItems: null, detail: "No active connection is visible. Asael cannot infer anything about the underlying domain." },
    backfill: { state: "not_started", detail: "No backfill has started because the source is not connected." },
    freshness: { state: "never", lastVerifiedAt: null, staleAfterSeconds: null },
    blindSpot: true,
    limitation: "Not connected means unknown, not empty.",
    nextAction: { state: "action_required", label: safeText(action), href },
  };
}

function knowledgeIndex(source: SourceCoverageInput["ownedSources"]): SourceCoverageProjection["knowledgeIndex"] {
  if (source.state === "unavailable") {
    return { state: "unknown", sourceItems: null, indexedDocuments: null, chunks: null, embeddedChunks: null, lastIndexedAt: null, detail: "The actor-owned index inventory is unavailable; no empty or complete state is inferred." };
  }
  const index = source.value.knowledgeIndex;
  const state = index.sourceItems === 0
    ? "empty" as const
    : index.indexedDocuments < index.sourceItems || index.embeddedChunks < index.chunks
      ? "partial" as const
      : "complete" as const;
  return {
    state,
    ...index,
    detail: state === "empty"
      ? "No actor-owned canonical source item is indexed."
      : state === "complete"
        ? "Every actor-owned indexed document chunk has an embedding receipt."
        : "Some actor-owned source items or chunks are not fully indexed; they remain an explicit retrieval blind spot.",
  };
}

function dependencyState<T>(source: SourceCoverageDependency<T>, readyDetail: string) {
  return source.state === "ready"
    ? { state: "ready" as const, detail: readyDetail }
    : { state: "unavailable" as const, detail: safeText(source.detail) };
}

function freshnessFrom(
  value: string | null | undefined,
  staleAfterSeconds: number,
  generatedAt: string,
  noObservationIsNotApplicable = false,
): SourceCoverageDomain["freshness"] {
  if (!value) {
    return noObservationIsNotApplicable
      ? { state: "not_applicable", lastVerifiedAt: null, staleAfterSeconds }
      : { state: "never", lastVerifiedAt: null, staleAfterSeconds };
  }
  const at = Date.parse(value);
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(at) || at > now) {
    return { state: "unknown", lastVerifiedAt: null, staleAfterSeconds };
  }
  return {
    state: now - at > staleAfterSeconds * 1_000 ? "stale" : "current",
    lastVerifiedAt: new Date(at).toISOString(),
    staleAfterSeconds,
  };
}

function newestTimestamp(values: readonly (string | null)[]) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) || null;
}

function canonicalTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Source coverage timestamp is invalid.");
  return date.toISOString();
}

function safeText(value: string) {
  return Array.from(value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim() || "This source is unavailable.").slice(0, 300).join("");
}

function failureLabel(code: string | undefined) {
  return ({
    provider_unauthorized: "an authorization error",
    provider_forbidden: "a permission error",
    provider_rate_limited: "provider rate limiting",
    provider_unavailable: "provider unavailability",
    processing_failed: "a processing error",
    none: "no reported failure",
  })[code || "none"] || "an unknown source error";
}
