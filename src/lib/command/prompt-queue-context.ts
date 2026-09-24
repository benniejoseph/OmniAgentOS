import "server-only";

import {
  commandContextReferencesSchema,
  type CommandContextReference,
} from "@/lib/command/composer-context-contract";
import { resolveCommandContextReferences } from "@/lib/command/context-reference-runtime";
import {
  promptQueueContextPinV1Schema,
  type PromptQueueContextPinV1,
} from "@/lib/command/prompt-queue-contracts";
import type { SecurityContext } from "@/lib/security/types";

/**
 * Revalidates exact Command references while retaining only content-free pins.
 * The resolved context block is deliberately discarded and must be rebuilt at
 * the final `/api/agent` admission boundary.
 */
export async function resolvePromptQueueContextPin(input: {
  context: SecurityContext;
  references: readonly CommandContextReference[];
  prompt: string;
  agentId: string;
  projectId?: string | null;
}): Promise<PromptQueueContextPinV1 | null> {
  const references = commandContextReferencesSchema.parse(input.references);
  if (!references.length) return null;
  const resolved = await resolveCommandContextReferences({
    context: input.context,
    references,
    query: input.prompt,
    agentId: input.agentId,
    projectId: input.projectId || undefined,
  });
  if (!resolved) return null;
  return promptQueueContextPinV1Schema.parse({
    schemaVersion: 1,
    references,
    selectionSha256: resolved.selectionSha256,
    contextBlockSha256: resolved.contextBlockSha256,
    receiptSha256: resolved.receiptSha256,
  });
}
