import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { AiUsageUnits } from "@/lib/usage/types";
import type { StudioParameterValue } from "./contracts";

/** This pin contains identifiers, never credentials. Store it with the accepted quote/attempt. */
export type StudioProviderRoute = {
  provider: "demo" | "google";
  model: string;
  ownerKey: string;
  credentialSource: "demo" | "tenant_vault" | "deployment_environment";
  connectionId?: string;
  credentialVersion?: number;
  assignmentId?: string;
  assignmentRevision?: number;
  assignmentConfigurationSha256?: string;
};
export type StudioProviderContext = {
  tenantId: string;
  actorId: string;
  sourceStreamId?: string;
  executionScope?: ExecutionScope;
  signal?: AbortSignal;
};
export type StudioProviderReference = {
  assetId: string;
  contentSha256: string;
  mediaType: string;
  role: string;
  bytes: Uint8Array;
};
export type StudioProviderRequest = {
  capabilityId: string;
  prompt: string;
  parameters: Record<string, StudioParameterValue>;
  references: StudioProviderReference[];
  submissionKey: string;
  route?: StudioProviderRoute;
};
export type StudioProviderHandle = {
  provider: "demo" | "google";
  model: string;
  requestId: string;
  capabilityId: string;
  submissionKey: string;
  route: StudioProviderRoute;
};
export type StudioProviderOutputDescriptor = {
  id: string;
  mediaType:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "video/mp4"
    | "video/webm";
  filename: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  demo: boolean;
  source:
    | { kind: "inline"; base64: string }
    | { kind: "remote"; url: string }
    | {
        kind: "fixture";
        name: "image-1.png" | "image-2.png" | "image-3.png" | "video.mp4";
      };
};
export type StudioProviderResult =
  | { status: "running"; handle: StudioProviderHandle }
  | {
      status: "completed";
      handle: StudioProviderHandle;
      outputs: StudioProviderOutputDescriptor[];
      usage?: AiUsageUnits;
    }
  | {
      status: "failed" | "canceled" | "moderated";
      handle: StudioProviderHandle;
      error: string;
      usage?: AiUsageUnits;
    };
export type StudioMaterializedOutput = Omit<
  StudioProviderOutputDescriptor,
  "source" | "id"
> & { bytes: Uint8Array };
export type StudioProviderFailureDisposition =
  | "rejected"
  | "uncertain_submission"
  | "transient_poll"
  | "retrieval";
export class StudioProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly disposition: StudioProviderFailureDisposition,
  ) {
    super(message);
    this.name = "StudioProviderError";
  }
}
