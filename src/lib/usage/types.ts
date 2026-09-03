import type { ExecutionScope } from "@/lib/security/execution-scope";

export const AI_USAGE_OPERATIONS = [
  "text_generation",
  "structured_generation",
  "tool_turn",
  "embedding",
  "web_search",
  "ocr",
  "image_generation",
  "transcription",
  "speech_synthesis",
  "browser_automation",
] as const;

export type AiUsageOperation = (typeof AI_USAGE_OPERATIONS)[number];

export type AiUsageUnits = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputCharacters?: number;
  inputBytes?: number;
  outputBytes?: number;
  inputAudioMilliseconds?: number;
  outputAudioMilliseconds?: number;
  imageCount?: number;
  searchQueryCount?: number;
  browserTaskCount?: number;
};

export type AiUsageScope = {
  tenantId: string;
  actorId: string;
  sourceStreamId: string;
  operation: AiUsageOperation;
  purpose: string;
  correlationId?: string;
  causationId?: string;
  executionScope?: ExecutionScope;
  assignmentId?: string;
  credentialSource?: "tenant_vault" | "deployment_environment";
};

export type AiUsageStatus = "completed" | "failed";

/** One provider request within a logical AI operation, including fallbacks. */
export type AiUsageCallReceipt = {
  sequence: number;
  provider: string;
  model: string;
  status: AiUsageStatus;
  usage: AiUsageUnits;
  latencyMs: number;
  estimatedCostMicrousd?: number;
  pricingSource?: string;
  pricingVersion?: string;
  providerRequestId?: string;
  failureKind?: string;
  retryable?: boolean;
};

export type AiUsageCallInput = Omit<
  AiUsageCallReceipt,
  "sequence" | "estimatedCostMicrousd" | "pricingSource" | "pricingVersion"
> & {
  sequence?: number;
  estimatedCostUsd?: number;
};

export type AiUsageRecord = AiUsageScope & {
  id: string;
  sourceEventId?: string;
  status: AiUsageStatus;
  provider: string;
  model: string;
  usage: AiUsageUnits;
  providerCallCount: number;
  attemptCount: number;
  failedAttemptCount: number;
  callReceipts: AiUsageCallReceipt[];
  latencyMs: number;
  estimatedCostMicrousd?: number;
  pricingSource?: string;
  pricingVersion?: string;
  providerRequestId?: string;
  failureKind?: string;
  retryable?: boolean;
  recordedAt: string;
};
