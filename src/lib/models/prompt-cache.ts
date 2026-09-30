import { createHmac } from "node:crypto";
import { claudeModelInBedrockId } from "@/lib/models/anthropic-capabilities";
import type { AiUsageScope } from "@/lib/usage/types";

const PROMPT_CACHE_KEY_PREFIX = "asael-pc-v1";

/**
 * Build a provider-safe cache bucket without disclosing tenant, actor, or run
 * identifiers. The key is stable for every model turn in one cache scope, or
 * in one source stream when the turn names no cache scope.
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
    .update(scope.promptCacheScope ?? scope.sourceStreamId)
    .digest("base64url");
  return `${PROMPT_CACHE_KEY_PREFIX}-${digest}`;
}

// Claude models documented to take Converse cache points: Claude 3.5 Sonnet
// v2, Claude 3.7 Sonnet, and every family from Claude 4 on, Claude 5 too.
const BEDROCK_CACHE_CLAUDE_MODELS =
  /^claude-(?:3-5-sonnet-20241022|3-7-sonnet|(?:opus|sonnet|haiku|fable|mythos)-[4-9])/;

/** Only add Converse cache points for model families documented to accept them. */
export function supportsBedrockPromptCache(model: string) {
  const normalized = model.trim().toLowerCase();
  const claude = claudeModelInBedrockId(normalized);
  return normalized.includes("amazon.nova-") ||
    (claude !== undefined && BEDROCK_CACHE_CLAUDE_MODELS.test(claude));
}
