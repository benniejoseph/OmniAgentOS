import "server-only";
import { reviewCompletionReceiptSchema } from "@/lib/self-improvement/review-contracts";
import type { AppBuilderSentinelVerdict } from "./sentinel-review";

/** Self-improvement uses a server-bound result, never the opening word of narration. */
export function parseBoundAppBuilderSentinelVerdict(receipt: unknown, binding: {
  tenantId: string; ownerActorId: string; projectId: string; sessionId: string;
  runId: string; verificationId: string; checkpointId: string; workspaceSha256: string;
}): AppBuilderSentinelVerdict {
  const parsed = reviewCompletionReceiptSchema.safeParse(receipt);
  if (!parsed.success || Object.entries(binding).some(([key, value]) => parsed.data[key as keyof typeof parsed.data] !== value)) {
    throw new Error("Sentinel criterion review does not bind this exact run and checkpoint.");
  }
  return parsed.data.outcome === "passed" ? "passed" : "blocked";
}
