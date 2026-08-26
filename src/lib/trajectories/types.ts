import type { RunStatus } from "@/lib/runs/types";

export type TrajectoryUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  costKnown: boolean;
  latencyMs: number;
  fallbackCount: number;
};

export type TrajectoryEvent = {
  seq: number;
  type: string;
  at: string;
  receipt: Record<string, string | number | boolean | null>;
};

export type RunTrajectory = {
  version: 2;
  run: {
    id: string;
    tenantId?: string;
    threadId?: string;
    mode: string;
    status: RunStatus;
    agentId?: string;
    specialistIds: string[];
    startedAt: string;
    completedAt?: string;
  };
  request: {
    promptLength: number;
    promptSha256: string;
    messageCount: number;
  };
  response?: {
    length: number;
    sha256: string;
  };
  usage: TrajectoryUsage;
  providers: string[];
  models: string[];
  toolExecutionIds: string[];
  learning: {
    feedbackVerdict?: "useful" | "needs_work";
    correctionLength?: number;
    correctionSha256?: string;
    groundingStatus?: "verified" | "not_required" | "missing" | "invalid";
    citedIds: string[];
    invalidCitationCount: number;
  };
  events: TrajectoryEvent[];
  runtime: {
    app: "asael";
    version: string;
    revision?: string;
  };
};

export type TrajectoryVerification = {
  valid: boolean;
  checks: {
    orderedEvents: boolean;
    terminalReceipt: boolean;
    usageTotals: boolean;
    toolReceipts: boolean;
  };
  issues: string[];
};
