import { z } from "zod";

import { arsenalAgents } from "@/lib/agents/arsenal";
import {
  buildBuiltInAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import type { BuiltInAgentId } from "@/lib/orchestration/prompts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const INTERNAL_AGENT_CARD_VERSION = "p8.5-agent-card:1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
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

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string().max(8_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema).max(128),
  z.record(z.string().min(1).max(160), jsonValueSchema),
]));

const uniqueList = (values: readonly string[], context: z.RefinementCtx) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Agent Card lists must be unique." });
  }
};

const capabilitySchema = z.object({
  capabilityId: idSchema,
  capabilitySha256: sha256Schema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(700),
  taskKinds: z.array(taskKindSchema).min(1).max(6).superRefine(uniqueList),
  semanticTags: z.array(
    z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9 -]*$/),
  ).min(1).max(32).superRefine(uniqueList),
  inputSchema: jsonValueSchema,
  inputSchemaSha256: sha256Schema,
  outputSchema: jsonValueSchema,
  outputSchemaSha256: sha256Schema,
  inputModalities: z.array(modalitySchema).min(1).max(3).superRefine(uniqueList),
  outputModalities: z.array(modalitySchema).min(1).max(3).superRefine(uniqueList),
  toolPolicy: z.enum([
    "none",
    "read_only",
    "governed_effects",
    "orchestration_only",
    "verification_only",
  ]),
}).strict().superRefine((value, context) => {
  const { capabilitySha256, ...body } = value;
  if (
    canonicalJsonSha256(body) !== capabilitySha256 ||
    canonicalJsonSha256(value.inputSchema) !== value.inputSchemaSha256 ||
    canonicalJsonSha256(value.outputSchema) !== value.outputSchemaSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["capabilitySha256"],
      message: "Agent capability integrity is invalid.",
    });
  }
  assertClosedSchema(value.inputSchema, context, ["inputSchema"]);
  assertClosedSchema(value.outputSchema, context, ["outputSchema"]);
});

export const internalAgentCardV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(INTERNAL_AGENT_CARD_VERSION),
  cardId: idSchema,
  cardSha256: sha256Schema,
  publicationState: z.literal("internal_only"),
  externalA2AEnabled: z.literal(false),
  logicalAgentId: idSchema,
  definitionVersion: z.number().int().min(1),
  definitionVersionId: idSchema,
  definitionSha256: sha256Schema,
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(700),
  availability: z.enum(["available", "paused"]),
  authentication: z.object({
    required: z.literal(true),
    scheme: z.literal("delegated_principal"),
    audience: z.literal("governed_orchestrator"),
    credentialForwarding: z.literal(false),
  }).strict(),
  protocols: z.object({
    task: z.literal("p8.3-delegation-task:1"),
    message: z.literal("p8.4-delegation-message:1"),
    artifact: z.literal("p8.4-shared-mission-artifact:1"),
    progress: z.literal("content_free_events"),
    cancellation: z.literal(true),
  }).strict(),
  limits: z.object({
    maxInputArtifacts: z.number().int().min(1).max(64),
    maxOutputArtifacts: z.number().int().min(1).max(32),
    maxOutputBytes: z.number().int().min(1).max(25_000_000),
    maxMessageChars: z.number().int().min(1).max(2_000),
    maxSharedArtifactChars: z.number().int().min(1).max(32_000),
    maxWallClockMs: z.number().int().min(101).max(3_600_000),
    maxFanOut: z.number().int().min(0).max(16),
  }).strict(),
  capabilities: z.array(capabilitySchema).min(1).max(16).superRefine(
    (values, context) => uniqueList(
      values.map((value) => value.capabilityId),
      context,
    ),
  ),
}).strict().superRefine((value, context) => {
  const { cardId, cardSha256, ...body } = value;
  if (
    cardId !== `agent-card:${cardSha256}` ||
    canonicalJsonSha256(body) !== cardSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["cardSha256"],
      message: "Agent Card integrity is invalid.",
    });
  }
});

export type InternalAgentCardV1 = Readonly<
  z.infer<typeof internalAgentCardV1Schema>
>;
export type AgentCardTaskKind = z.infer<typeof taskKindSchema>;
export type AgentCardModality = z.infer<typeof modalitySchema>;

const taskInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["objective", "acceptanceCriteria", "inputArtifacts"],
  properties: {
    objective: { type: "string", minLength: 3, maxLength: 4_000 },
    acceptanceCriteria: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "criterionId",
          "statement",
          "verificationMethod",
          "required",
        ],
        properties: {
          criterionId: { type: "string", minLength: 1, maxLength: 240 },
          statement: { type: "string", minLength: 3, maxLength: 1_000 },
          verificationMethod: {
            type: "string",
            enum: ["schema", "evidence", "governed_receipt", "parent_verifier"],
          },
          required: { const: true },
        },
      },
    },
    inputArtifacts: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "artifactId",
          "sourceExecutionId",
          "name",
          "kind",
          "mediaType",
          "contentSha256",
          "byteCount",
          "evidenceIds",
        ],
        properties: {
          artifactId: { type: "string", minLength: 1, maxLength: 240 },
          sourceExecutionId: { type: "string", minLength: 1, maxLength: 240 },
          name: { type: "string", minLength: 1, maxLength: 160 },
          kind: {
            type: "string",
            enum: ["analysis", "result", "verification", "report", "memory", "control"],
          },
          mediaType: { type: "string", minLength: 3, maxLength: 120 },
          contentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          byteCount: { type: "integer", minimum: 1, maximum: 25_000_000 },
          evidenceIds: {
            type: "array",
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 240 },
          },
        },
      },
    },
  },
});

const taskOutputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "artifacts",
    "acceptanceChecks",
  ],
  properties: {
    status: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: 4_000 },
    artifacts: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind", "content", "evidenceIds"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 160 },
          kind: { type: "string", minLength: 1, maxLength: 80 },
          content: { type: "string", minLength: 1, maxLength: 32_000 },
          evidenceIds: {
            type: "array",
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 240 },
          },
        },
      },
    },
    acceptanceChecks: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "passed", "evidenceIds", "note"],
        properties: {
          criterion: { type: "string", minLength: 3, maxLength: 1_000 },
          passed: { type: "boolean" },
          evidenceIds: {
            type: "array",
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 240 },
          },
          note: { type: "string", maxLength: 2_000 },
        },
      },
    },
  },
});

const specialtyByAgent: Record<BuiltInAgentId, Readonly<{
  taskKind: Exclude<AgentCardTaskKind, "general">;
  tags: readonly string[];
  toolPolicy: InternalAgentCardV1["capabilities"][number]["toolPolicy"];
}>> = {
  atlas: {
    taskKind: "coordinate",
    tags: ["planning", "coordination", "delegation", "synthesis"],
    toolPolicy: "orchestration_only",
  },
  scout: {
    taskKind: "research",
    tags: ["research", "sources", "comparison", "citations"],
    toolPolicy: "read_only",
  },
  meridian: {
    taskKind: "research",
    tags: ["markets", "macroeconomics", "ict", "backtests", "calibration"],
    toolPolicy: "read_only",
  },
  forge: {
    taskKind: "build",
    tags: ["build", "implementation", "artifact", "automation"],
    toolPolicy: "governed_effects",
  },
  sentinel: {
    taskKind: "verify",
    tags: ["verification", "review", "safety", "quality", "risk"],
    toolPolicy: "verification_only",
  },
  mnemosyne: {
    taskKind: "memory",
    tags: ["memory", "knowledge", "entities", "contradictions", "context"],
    toolPolicy: "read_only",
  },
};

export function buildInternalAgentCardV1(input: {
  agentId: BuiltInAgentId;
  tenantId: string;
  controllerActorId: string;
}) {
  const identity = buildBuiltInAgentIdentityV1(input);
  const profile = arsenalAgents.find((agent) => agent.id === input.agentId);
  if (!profile) throw new Error(`Unknown internal Agent ${input.agentId}.`);
  const specialty = specialtyByAgent[input.agentId];
  const capabilityBodies = [
    {
      capabilityId: `agent-capability:${input.agentId}:general`,
      name: "Bounded reasoning task",
      description: "Completes one contract-bound reasoning task and proposes a verifiable result.",
      taskKinds: ["general" as const],
      semanticTags: uniqueTags(["reasoning", "analysis", profile.role]),
      toolPolicy: "none" as const,
    },
    {
      capabilityId: `agent-capability:${input.agentId}:${specialty.taskKind}`,
      name: `${profile.role} specialization`,
      description: profile.description,
      taskKinds: [specialty.taskKind],
      semanticTags: uniqueTags([
        ...specialty.tags,
        ...profile.capabilities,
        ...profile.persona.allowedDomains,
      ]),
      toolPolicy: specialty.toolPolicy,
    },
  ].map((capability) => capabilityWithIntegrity({
    ...capability,
    inputSchema: taskInputSchema,
    outputSchema: taskOutputSchema,
    inputModalities: ["text", "artifact_reference"] as const,
    outputModalities: [
      "text",
      "application/json",
      "artifact_reference",
    ] as const,
  }));
  const body = {
    schemaVersion: 1 as const,
    version: INTERNAL_AGENT_CARD_VERSION,
    publicationState: "internal_only" as const,
    externalA2AEnabled: false as const,
    logicalAgentId: identity.definition.logicalAgentId,
    definitionVersion: identity.definition.definitionVersion,
    definitionVersionId: identity.definition.definitionVersionId,
    definitionSha256: identity.definition.definitionSha256,
    name: identity.definition.name,
    role: identity.definition.role,
    description: identity.definition.description,
    availability: identity.definition.status === "paused"
      ? "paused" as const
      : "available" as const,
    authentication: {
      required: true as const,
      scheme: "delegated_principal" as const,
      audience: "governed_orchestrator" as const,
      credentialForwarding: false as const,
    },
    protocols: {
      task: "p8.3-delegation-task:1" as const,
      message: "p8.4-delegation-message:1" as const,
      artifact: "p8.4-shared-mission-artifact:1" as const,
      progress: "content_free_events" as const,
      cancellation: true as const,
    },
    limits: {
      maxInputArtifacts: 32,
      maxOutputArtifacts: 8,
      maxOutputBytes: 64_000,
      maxMessageChars: 2_000,
      maxSharedArtifactChars: 32_000,
      maxWallClockMs: 900_000,
      maxFanOut: input.agentId === "atlas" ? 3 : 0,
    },
    capabilities: capabilityBodies,
  };
  const cardSha256 = canonicalJsonSha256(body);
  return deepFreeze(internalAgentCardV1Schema.parse({
    ...body,
    cardId: `agent-card:${cardSha256}`,
    cardSha256,
  }));
}

export function listInternalAgentCardsV1(input: {
  tenantId: string;
  controllerActorId: string;
}) {
  return deepFreeze(arsenalAgents.map((agent) => buildInternalAgentCardV1({
    agentId: agent.id as BuiltInAgentId,
    ...input,
  })));
}

export function parseInternalAgentCardV1(value: unknown) {
  return deepFreeze(internalAgentCardV1Schema.parse(value));
}

function capabilityWithIntegrity(input: {
  capabilityId: string;
  name: string;
  description: string;
  taskKinds: readonly AgentCardTaskKind[];
  semanticTags: readonly string[];
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  inputModalities: readonly AgentCardModality[];
  outputModalities: readonly AgentCardModality[];
  toolPolicy: InternalAgentCardV1["capabilities"][number]["toolPolicy"];
}) {
  const body = {
    ...input,
    taskKinds: [...input.taskKinds],
    semanticTags: [...input.semanticTags],
    inputModalities: [...input.inputModalities],
    outputModalities: [...input.outputModalities],
    inputSchemaSha256: canonicalJsonSha256(input.inputSchema),
    outputSchemaSha256: canonicalJsonSha256(input.outputSchema),
  };
  return { ...body, capabilitySha256: canonicalJsonSha256(body) };
}

function uniqueTags(values: readonly string[]) {
  return [...new Set(values.flatMap((value) => value
    .toLowerCase()
    .replace(/[^a-z0-9 -]+/g, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 2)
  ))].sort().slice(0, 32);
}

function assertClosedSchema(
  value: JsonValue,
  context: z.RefinementCtx,
  path: PropertyKey[],
) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    context.addIssue({ code: "custom", path, message: "Agent capability schema must be an object." });
    return;
  }
  const root = value as Record<string, JsonValue>;
  if (root.type !== "object") {
    context.addIssue({ code: "custom", path, message: "Agent capability schemas must be closed objects." });
    return;
  }
  assertClosedSchemaNode(root, context, path);
}

function assertClosedSchemaNode(
  schema: Record<string, JsonValue>,
  context: z.RefinementCtx,
  path: PropertyKey[],
) {
  if (schema.type === "object" && schema.additionalProperties !== false) {
    context.addIssue({ code: "custom", path, message: "Agent capability object schemas must be closed." });
  }
  const properties = schema.properties;
  if (properties && !Array.isArray(properties) && typeof properties === "object") {
    for (const [key, child] of Object.entries(properties)) {
      if (child && !Array.isArray(child) && typeof child === "object") {
        assertClosedSchemaNode(child as Record<string, JsonValue>, context, [
          ...path,
          "properties",
          key,
        ]);
      }
    }
  }
  const items = schema.items;
  if (items && !Array.isArray(items) && typeof items === "object") {
    assertClosedSchemaNode(items as Record<string, JsonValue>, context, [
      ...path,
      "items",
    ]);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
