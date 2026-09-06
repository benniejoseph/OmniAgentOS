import { createHmac } from "node:crypto";
import type { AiUsageScope } from "@/lib/usage/types";

const PROMPT_CACHE_KEY_PREFIX = "asael-pc-v1";

/**
 * Build a provider-safe cache bucket without disclosing tenant, actor, or run
 * identifiers. The key is stable for every model turn in one source stream.
 */
export function promptCacheKeyForScope(
  scope: AiUsageScope | undefined,
): string | undefined {
  const secret = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
  if (!scope || !secret) return undefined;
  const digest = createHmac("sha256", secret)
    .update(PROMPT_CACHE_KEY_PREFIX)
    .update("\0")
    .update(scope.tenantId)
    .update("\0")
    .update(scope.actorId)
    .update("\0")
    .update(scope.sourceStreamId)
    .digest("base64url");
  return `${PROMPT_CACHE_KEY_PREFIX}-${digest}`;
}

/** Only add Converse cache points for model families documented to accept them. */
export function supportsBedrockPromptCache(model: string) {
  const normalized = model.trim().toLowerCase();
  return normalized.includes("amazon.nova-") ||
    /anthropic\.claude-(?:3-5-sonnet-20241022-v2|3-7-sonnet|(?:opus|sonnet|haiku)-4)/.test(
      normalized,
    );
}
