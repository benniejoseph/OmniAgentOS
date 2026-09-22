import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export type RuntimeModelRoutingPinInput = Readonly<{
  scope: string;
  source: "tenant_assignment" | "deployment_environment";
  providerId: "openai" | "google" | "anthropic" | "aws_bedrock";
  modelId: string;
  tier: "fast" | "reasoning";
  assignmentId?: string | null;
  assignmentRevision?: number | null;
  assignmentConfigurationSha256?: string | null;
}>;

/**
 * Content-free receipt for the complete model-routing decision. Provider,
 * model, and tier alone are insufficient: assignment revision, configuration,
 * source, and scope are authority-relevant durable execution pins too.
 */
export function runtimeModelRoutingPolicySha256(
  input: RuntimeModelRoutingPinInput,
) {
  return canonicalJsonSha256({
    schemaVersion: 1,
    scope: input.scope,
    source: input.source,
    providerId: input.providerId,
    modelId: input.modelId,
    tier: input.tier,
    assignmentId: input.assignmentId ?? null,
    assignmentRevision: input.assignmentRevision ?? null,
    assignmentConfigurationSha256:
      input.assignmentConfigurationSha256 ?? null,
  });
}
