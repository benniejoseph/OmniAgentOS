import { z } from "zod";

import {
  internalAgentCardV1Schema,
  parseInternalAgentCardV1,
  type AgentCardModality,
  type AgentCardTaskKind,
  type InternalAgentCardV1,
} from "@/lib/agents/discovery-card";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const AGENT_DISCOVERY_RECEIPT_VERSION =
  "p8.5-agent-discovery-receipt:1" as const;

// When semantic evidence is tied, prefer the broad internal specialist before
// a narrower domain specialist. A domain-specific query still wins on overlap
// (for example, market/ICT terms route to Meridian rather than Scout).
const agentDiscoveryTieBreakPriority = new Map<string, number>(
  ["atlas", "scout", "meridian", "forge", "sentinel", "mnemosyne"].map(
    (agentId, index) => [agentId, index],
  ),
);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const taskKindSchema = z.enum([
  "general",
  "coordinate",
  "research",
  "build",
  "verify",
  "memory",
]);
const modalitySchema = z.enum([
  "text",
  "application/json",
  "artifact_reference",
]);
const uniqueList = (values: readonly string[], context: z.RefinementCtx) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Discovery lists must be unique." });
  }
};

const discoveryRequestSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  taskKinds: z.array(taskKindSchema).min(1).max(6).superRefine(uniqueList),
  inputModalities: z.array(modalitySchema).min(1).max(3).superRefine(uniqueList),
  outputModalities: z.array(modalitySchema).min(1).max(3).superRefine(uniqueList),
  limits: z.object({
    maxInputArtifacts: z.number().int().min(0).max(64),
    maxOutputArtifacts: z.number().int().min(0).max(32),
    maxOutputBytes: z.number().int().min(1).max(25_000_000),
    maxWallClockMs: z.number().int().min(101).max(3_600_000),
    maxFanOut: z.number().int().min(0).max(16),
  }).strict(),
  authenticationScheme: z.literal("delegated_principal"),
}).strict();

export type AgentDiscoveryRequestV1 = Readonly<
  z.infer<typeof discoveryRequestSchema>
>;

const matchSchema = z.object({
  agentId: z.string().trim().min(1).max(240),
  cardId: z.string().trim().min(1).max(240),
  cardSha256: sha256Schema,
  definitionVersion: z.number().int().min(1),
  capabilityIds: z.array(z.string().trim().min(1).max(240)).min(1).max(16),
  matchedTaskKinds: z.array(taskKindSchema).min(1).max(6),
  semanticOverlap: z.number().int().min(0).max(1_000),
  score: z.number().int().min(1),
}).strict();

const discoveryReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(AGENT_DISCOVERY_RECEIPT_VERSION),
  receiptSha256: sha256Schema,
  requestSha256: sha256Schema,
  candidateCardSha256s: z.array(sha256Schema).max(64),
  matches: z.array(matchSchema).max(64),
  rejectedCardIds: z.array(z.string().trim().min(1).max(240)).max(64),
  authorityImpact: z.literal("none"),
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...body } = value;
  if (canonicalJsonSha256(body) !== receiptSha256) {
    context.addIssue({
      code: "custom",
      path: ["receiptSha256"],
      message: "Agent discovery receipt integrity is invalid.",
    });
  }
});

export type AgentDiscoveryReceiptV1 = Readonly<
  z.infer<typeof discoveryReceiptSchema>
>;

export function discoverInternalAgentsV1(input: {
  cards: readonly InternalAgentCardV1[];
  request: AgentDiscoveryRequestV1;
}) {
  const request = discoveryRequestSchema.parse(input.request);
  const cards = input.cards.map(parseInternalAgentCardV1);
  const queryTokens = semanticTokens(request.query);
  const matches: z.infer<typeof matchSchema>[] = [];
  const rejectedCardIds: string[] = [];
  for (const card of cards) {
    const compatibility = validateAgentCardCompatibilityV1({ card, request });
    if (!compatibility.compatible) {
      rejectedCardIds.push(card.cardId);
      continue;
    }
    const semanticOverlap = compatibility.capabilities.reduce(
      (total, capability) => total + semanticOverlapScore(
        queryTokens,
        capability,
      ),
      0,
    );
    const matchedTaskKinds = [...new Set(compatibility.capabilities.flatMap(
      (capability) => capability.taskKinds.filter((kind) =>
        request.taskKinds.includes(kind)
      ),
    ))];
    matches.push(matchSchema.parse({
      agentId: card.logicalAgentId,
      cardId: card.cardId,
      cardSha256: card.cardSha256,
      definitionVersion: card.definitionVersion,
      capabilityIds: compatibility.capabilities.map(
        (capability) => capability.capabilityId,
      ),
      matchedTaskKinds,
      semanticOverlap,
      score: (matchedTaskKinds.length * 1_000) +
        (semanticOverlap * 10) +
        (card.availability === "available" ? 1 : 0),
    }));
  }
  matches.sort((left, right) =>
    right.score - left.score ||
    (agentDiscoveryTieBreakPriority.get(left.agentId) ?? Number.MAX_SAFE_INTEGER) -
      (agentDiscoveryTieBreakPriority.get(right.agentId) ?? Number.MAX_SAFE_INTEGER) ||
    left.agentId.localeCompare(right.agentId)
  );
  const body = {
    schemaVersion: 1 as const,
    version: AGENT_DISCOVERY_RECEIPT_VERSION,
    requestSha256: canonicalJsonSha256(request),
    candidateCardSha256s: cards.map((card) => card.cardSha256).sort(),
    matches,
    rejectedCardIds: rejectedCardIds.sort(),
    authorityImpact: "none" as const,
  };
  return deepFreeze(discoveryReceiptSchema.parse({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  }));
}

export function validateAgentCardCompatibilityV1(input: {
  card: InternalAgentCardV1;
  request: AgentDiscoveryRequestV1;
}): Readonly<
  | {
      compatible: true;
      capabilities: readonly InternalAgentCardV1["capabilities"][number][];
    }
  | { compatible: false; reasons: readonly string[] }
> {
  const card = internalAgentCardV1Schema.parse(input.card);
  const request = discoveryRequestSchema.parse(input.request);
  const reasons: string[] = [];
  if (card.availability !== "available") reasons.push("agent_unavailable");
  if (
    card.authentication.scheme !== request.authenticationScheme ||
    !card.authentication.required ||
    card.authentication.credentialForwarding
  ) reasons.push("authentication_incompatible");
  if (!withinLimits(card, request)) reasons.push("limits_exceeded");
  const capabilities = card.capabilities.filter((capability) =>
    capability.taskKinds.some((kind) => request.taskKinds.includes(kind)) &&
    hasEvery(capability.inputModalities, request.inputModalities) &&
    hasEvery(capability.outputModalities, request.outputModalities)
  );
  if (!capabilities.length) reasons.push("capability_incompatible");
  return reasons.length
    ? deepFreeze({ compatible: false as const, reasons })
    : deepFreeze({ compatible: true as const, capabilities });
}

export function selectAgentTeamFromCardsV1(input: {
  cards: readonly InternalAgentCardV1[];
  query: string;
  taskKinds: readonly Exclude<AgentCardTaskKind, "general">[];
  consequential: boolean;
  preferredAgentId?: string;
}) {
  const cards = input.cards.map(parseInternalAgentCardV1);
  const requestedKinds = [...new Set(input.taskKinds)];
  const primaryKind = requestedKinds.includes("memory")
    ? "memory" as const
    : requestedKinds.includes("build")
      ? "build" as const
      : requestedKinds.includes("research")
        ? "research" as const
        : requestedKinds.includes("verify")
          ? "verify" as const
          : "coordinate" as const;
  const selected = new Set<string>();
  const discoveryReceipts: AgentDiscoveryReceiptV1[] = [];
  const discover = (taskKind: AgentCardTaskKind) => {
    const receipt = discoverInternalAgentsV1({
      cards,
      request: defaultDiscoveryRequest(input.query, taskKind),
    });
    discoveryReceipts.push(receipt);
    return receipt.matches[0]?.agentId;
  };
  const preferred = input.preferredAgentId
    ? cards.find((card) =>
        card.logicalAgentId === input.preferredAgentId &&
        validateAgentCardCompatibilityV1({
          card,
          request: defaultDiscoveryRequest(input.query, primaryKind),
        }).compatible
      )
    : undefined;
  const primaryAgentId = preferred?.logicalAgentId || discover(primaryKind);
  if (!primaryAgentId) throw new Error("No compatible internal Agent Card was discovered.");
  selected.add(primaryAgentId);
  for (const taskKind of requestedKinds) {
    const agentId = discover(taskKind);
    if (!agentId) throw new Error(`No compatible Agent Card covers ${taskKind}.`);
    selected.add(agentId);
  }
  if (requestedKinds.includes("coordinate") && primaryAgentId !== "atlas") {
    const coordinator = discover("coordinate");
    if (!coordinator) throw new Error("No compatible coordination Agent Card was discovered.");
    selected.add(coordinator);
  }
  if (
    requestedKinds.includes("verify") ||
    input.consequential ||
    selected.size > 1
  ) {
    const verifier = discover("verify");
    if (!verifier) throw new Error("No compatible verification Agent Card was discovered.");
    selected.add(verifier);
  }
  const body = {
    primaryAgentId,
    specialistIds: [...selected],
    cardSha256s: [...selected].map((agentId) =>
      cards.find((card) => card.logicalAgentId === agentId)!.cardSha256
    ),
    discoveryReceiptSha256s: discoveryReceipts.map(
      (receipt) => receipt.receiptSha256,
    ),
  };
  return deepFreeze({
    ...body,
    selectionSha256: canonicalJsonSha256({
      version: "p8.5-agent-team-selection:1",
      ...body,
    }),
  });
}

function defaultDiscoveryRequest(
  query: string,
  taskKind: AgentCardTaskKind,
): AgentDiscoveryRequestV1 {
  return {
    query: query.trim() || "bounded task",
    taskKinds: [taskKind],
    inputModalities: ["text", "artifact_reference"],
    outputModalities: ["application/json", "artifact_reference"],
    limits: {
      maxInputArtifacts: 32,
      maxOutputArtifacts: 8,
      maxOutputBytes: 64_000,
      maxWallClockMs: 900_000,
      maxFanOut: 0,
    },
    authenticationScheme: "delegated_principal",
  };
}

function withinLimits(
  card: InternalAgentCardV1,
  request: AgentDiscoveryRequestV1,
) {
  return request.limits.maxInputArtifacts <= card.limits.maxInputArtifacts &&
    request.limits.maxOutputArtifacts <= card.limits.maxOutputArtifacts &&
    request.limits.maxOutputBytes <= card.limits.maxOutputBytes &&
    request.limits.maxWallClockMs <= card.limits.maxWallClockMs &&
    request.limits.maxFanOut <= card.limits.maxFanOut;
}

function hasEvery(
  offered: readonly AgentCardModality[],
  requested: readonly AgentCardModality[],
) {
  return requested.every((modality) => offered.includes(modality));
}

function semanticTokens(value: string) {
  return new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function semanticOverlapScore(
  query: ReadonlySet<string>,
  capability: InternalAgentCardV1["capabilities"][number],
) {
  const surface = semanticTokens([
    capability.name,
    capability.description,
    ...capability.semanticTags,
  ].join(" "));
  let score = 0;
  for (const token of query) if (surface.has(token)) score += 1;
  return score;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
