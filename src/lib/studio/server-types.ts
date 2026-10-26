import type { StudioCapabilityPin } from "./request-contract";
import type {
  StudioAsset,
  StudioFlow,
  StudioQuote,
  StudioRun,
  StudioRunEvent,
} from "./contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type {
  StudioProviderHandle,
  StudioProviderResult,
  StudioProviderRoute,
} from "./provider-types";

export class StudioError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "studio_invalid",
    readonly issues?: unknown[],
  ) {
    super(message);
    this.name = "StudioError";
  }
}
export type StudioOwner = {
  tenantId: string;
  actorId: string;
  legacyActorId?: string;
};
export type StudioRecordKind =
  "flow" | "quote" | "run" | "attempt" | "request" | "project_profile";
export type StoredFlow = StudioFlow;
export type StoredQuote = {
  value: StudioQuote;
  configurationHashes: Record<string, string>;
  dependencies: Record<string, string[]>;
  reusable: Record<
    string,
    {
      configurationHash: string;
      inputAssets: StudioAsset[];
      outputAssets: StudioAsset[];
      runId?: string;
    }
  >;
  assetPins: Record<string, StudioAsset>;
  requestHash: string;
  routes: Record<string, StudioProviderRoute>;
  capabilityPins: Record<string, StudioCapabilityPin>;
};
export type StoredRun = {
  value: StudioRun;
  dependencies: Record<string, string[]>;
  assetPins: Record<string, StudioAsset>;
  executionScope: ExecutionScope;
  revision: number;
  lastEventSeq: number;
  quoteId: string;
  requestHash: string;
  legacyActorId?: string;
  workspaceId: string;
  projectId: string | null;
  generationCount: number;
  pollCount: number;
  routes: Record<string, StudioProviderRoute>;
  capabilityPins: Record<string, StudioCapabilityPin>;
  reusable: StoredQuote["reusable"];
  lastError?: string;
};
export type StoredAttempt = {
  id: string;
  runId: string;
  nodeId: string;
  submissionKey: string;
  providerPrompt?: string;
  pollCount?: number;
  status:
    | "submitting"
    | "running"
    | "persisting"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "canceled"
    | "moderated";
  handle?: StudioProviderHandle;
  result?: StudioProviderResult;
  persistedAssetIds: string[];
  startedAt: string;
  updatedAt: string;
  error?: string;
  cancellationRequestedAt?: string;
  cancellationSent?: boolean;
};
export type StoredRequest = {
  requestHash: string;
  kind: "flow" | "run" | "project_profile";
  targetId: string;
};
export type StudioEvent = StudioRunEvent;
export const STUDIO_MAX_GENERATIONS = 8;
export const STUDIO_MAX_ACTIVE_RUNS = 2;
export const studioJobKey = (runId: string) => `studio-run:${runId}`;
