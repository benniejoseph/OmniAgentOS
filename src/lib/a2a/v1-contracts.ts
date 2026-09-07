import { z } from "zod";

import type { InternalAgentCardV1 } from "@/lib/agents/discovery-card";
import type { DelegationTaskState } from "@/lib/delegation/lifecycle";

export const A2A_PROTOCOL_VERSION = "1.0" as const;
export const A2A_MEDIA_TYPE = "application/a2a+json" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const urlSchema = z.string().url().max(2_048);
const mediaTypeSchema = z.string().trim().min(3).max(120).regex(
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/,
);

type JsonValue = string | number | boolean | null | JsonValue[] | {
  [key: string]: JsonValue;
};
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string().max(32_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema).max(128),
  z.record(z.string().min(1).max(160), jsonValueSchema),
]));

const metadataSchema = z.record(
  z.string().min(1).max(160),
  jsonValueSchema,
).superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 16_384) {
    context.addIssue({
      code: "custom",
      message: "A2A metadata exceeds the 16 KiB boundary.",
    });
  }
});

export const a2aPartV1Schema = z.object({
  text: z.string().min(1).max(32_000).optional(),
  data: jsonValueSchema.optional(),
  mediaType: mediaTypeSchema.optional(),
  filename: z.string().trim().min(1).max(240).optional(),
  metadata: metadataSchema.optional(),
}).strict().superRefine((value, context) => {
  if (Number(value.text !== undefined) + Number(value.data !== undefined) !== 1) {
    context.addIssue({
      code: "custom",
      message: "An A2A Part must contain exactly one supported content field.",
    });
  }
});

export const a2aMessageV1Schema = z.object({
  messageId: idSchema,
  contextId: idSchema.optional(),
  taskId: idSchema.optional(),
  role: z.enum(["ROLE_USER", "ROLE_AGENT"]),
  parts: z.array(a2aPartV1Schema).min(1).max(16),
  metadata: metadataSchema.optional(),
  extensions: z.array(urlSchema).max(8).optional(),
  referenceTaskIds: z.array(idSchema).max(16).optional(),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value.parts), "utf8") > 65_536) {
    context.addIssue({
      code: "custom",
      path: ["parts"],
      message: "A2A Message content exceeds the 64 KiB boundary.",
    });
  }
});

export const a2aArtifactV1Schema = z.object({
  artifactId: idSchema,
  name: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().min(1).max(1_000).optional(),
  parts: z.array(a2aPartV1Schema).min(1).max(16),
  metadata: metadataSchema.optional(),
  extensions: z.array(urlSchema).max(8).optional(),
}).strict();

export const a2aTaskStateV1Schema = z.enum([
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export type A2ATaskStateV1 = z.infer<typeof a2aTaskStateV1Schema>;

export const a2aTaskStatusV1Schema = z.object({
  state: a2aTaskStateV1Schema,
  message: a2aMessageV1Schema.optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
}).strict();

export const a2aTaskV1Schema = z.object({
  id: idSchema,
  contextId: idSchema.optional(),
  status: a2aTaskStatusV1Schema,
  artifacts: z.array(a2aArtifactV1Schema).max(32).optional(),
  history: z.array(a2aMessageV1Schema).max(50).optional(),
  metadata: metadataSchema.optional(),
}).strict();

const sendConfigurationSchema = z.object({
  acceptedOutputModes: z.array(mediaTypeSchema).min(1).max(8).optional(),
  historyLength: z.number().int().min(0).max(50).optional(),
  blocking: z.boolean().optional(),
}).strict();

export const a2aSendMessageRequestV1Schema = z.object({
  message: a2aMessageV1Schema,
  configuration: sendConfigurationSchema.optional(),
  metadata: metadataSchema.optional(),
}).strict();

const securityRequirementSchema = z.record(
  z.string().min(1).max(120),
  z.array(z.string().min(1).max(160)).max(16),
);

const agentSkillSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(700),
  tags: z.array(z.string().trim().min(1).max(80)).min(1).max(32),
  examples: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  inputModes: z.array(mediaTypeSchema).min(1).max(8).optional(),
  outputModes: z.array(mediaTypeSchema).min(1).max(8).optional(),
  securityRequirements: z.array(securityRequirementSchema).max(8).optional(),
}).strict();

export const a2aAgentCardV1Schema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(700),
  supportedInterfaces: z.array(z.object({
    url: urlSchema,
    protocolBinding: z.literal("HTTP+JSON"),
    protocolVersion: z.literal(A2A_PROTOCOL_VERSION),
  }).strict()).length(1),
  provider: z.object({
    organization: z.string().trim().min(1).max(120),
    url: urlSchema,
  }).strict().optional(),
  version: z.string().trim().min(1).max(80),
  documentationUrl: urlSchema.optional(),
  capabilities: z.object({
    streaming: z.literal(true),
    pushNotifications: z.literal(false),
    extendedAgentCard: z.literal(true),
  }).strict(),
  securitySchemes: z.object({
    asaelServiceApiKey: z.object({
      httpAuthSecurityScheme: z.object({
        scheme: z.literal("Bearer"),
        bearerFormat: z.literal("Asael service API key"),
        description: z.string().trim().min(1).max(300),
      }).strict(),
    }).strict(),
  }).strict(),
  securityRequirements: z.tuple([
    z.object({ asaelServiceApiKey: z.array(z.string()).length(0) }).strict(),
  ]),
  defaultInputModes: z.tuple([
    z.literal("text/plain"),
    z.literal("application/json"),
  ]),
  defaultOutputModes: z.tuple([
    z.literal("text/plain"),
    z.literal("application/json"),
  ]),
  skills: z.array(agentSkillSchema).min(1).max(64),
}).strict();

export type A2AMessageV1 = Readonly<z.infer<typeof a2aMessageV1Schema>>;
export type A2AArtifactV1 = Readonly<z.infer<typeof a2aArtifactV1Schema>>;
export type A2ATaskV1 = Readonly<z.infer<typeof a2aTaskV1Schema>>;
export type A2AAgentCardV1 = Readonly<z.infer<typeof a2aAgentCardV1Schema>>;

export class A2AProtocolError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 421 | 429 | 500 | 503,
    readonly code: string,
  ) {
    super(message);
    this.name = "A2AProtocolError";
  }
}

export function assertA2AProtocolVersion(request: Request) {
  const supplied = request.headers.get("A2A-Version")?.trim();
  if (supplied !== A2A_PROTOCOL_VERSION) {
    throw new A2AProtocolError(
      "This endpoint requires A2A protocol version 1.0.",
      400,
      "version_not_supported",
    );
  }
  return A2A_PROTOCOL_VERSION;
}

export function buildAsaelA2AAgentCardV1(input: {
  baseUrl: string;
  releaseVersion: string;
  internalCards?: readonly InternalAgentCardV1[];
}) {
  const baseUrl = new URL(input.baseUrl);
  const endpoint = new URL("api/a2a/", ensureTrailingSlash(baseUrl)).toString();
  const cards = input.internalCards || [];
  const skills = cards.length
    ? cards.flatMap((card) => card.capabilities.map((capability) => ({
        id: `asael.${card.logicalAgentId}.${capability.capabilityId}`.slice(0, 240),
        name: capability.name,
        description: capability.description,
        tags: [...capability.semanticTags],
        inputModes: modalitiesToMediaTypes(capability.inputModalities),
        outputModes: modalitiesToMediaTypes(capability.outputModalities),
        securityRequirements: [{ asaelServiceApiKey: [] }],
      })))
    : [{
        id: "asael.governed-task",
        name: "Governed task delegation",
        description:
          "Submit bounded tasks whose effects remain subject to Asael policy, approval, idempotency, and independent verification.",
        tags: ["delegation", "governed execution", "artifacts"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["text/plain", "application/json"],
        securityRequirements: [{ asaelServiceApiKey: [] }],
      }];
  return deepFreeze(a2aAgentCardV1Schema.parse({
    name: "Asael",
    description:
      "A governed personal AI operating system with bounded delegation and independently verified task outcomes.",
    supportedInterfaces: [{
      url: endpoint,
      protocolBinding: "HTTP+JSON",
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    provider: {
      organization: "Asael",
      url: baseUrl.origin,
    },
    version: input.releaseVersion,
    documentationUrl: new URL("docs", ensureTrailingSlash(baseUrl)).toString(),
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: true,
    },
    securitySchemes: {
      asaelServiceApiKey: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          bearerFormat: "Asael service API key",
          description:
            "Use a revocable Asael service API key with explicit A2A scopes.",
        },
      },
    },
    securityRequirements: [{ asaelServiceApiKey: [] }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills,
  }));
}

export function delegationStateToA2AState(
  state: DelegationTaskState,
): A2ATaskStateV1 {
  switch (state) {
    case "proposed":
    case "accepted":
      return "TASK_STATE_SUBMITTED";
    case "working":
    case "completed_proposed":
      return "TASK_STATE_WORKING";
    case "waiting":
    case "challenged":
      return "TASK_STATE_INPUT_REQUIRED";
    case "result_accepted":
      return "TASK_STATE_COMPLETED";
    case "rejected":
      return "TASK_STATE_REJECTED";
    case "canceled":
      return "TASK_STATE_CANCELED";
    case "expired":
      return "TASK_STATE_FAILED";
  }
}

export function parseA2AMessageV1(value: unknown) {
  return deepFreeze(a2aMessageV1Schema.parse(value));
}

export function parseA2ATaskV1(value: unknown) {
  return deepFreeze(a2aTaskV1Schema.parse(value));
}

export function parseA2AAgentCardV1(value: unknown) {
  return deepFreeze(a2aAgentCardV1Schema.parse(value));
}

function modalitiesToMediaTypes(values: readonly string[]) {
  const modes = new Set<string>();
  for (const value of values) {
    if (value === "text") modes.add("text/plain");
    if (value === "application/json" || value === "artifact_reference") {
      modes.add("application/json");
    }
  }
  return [...modes];
}

function ensureTrailingSlash(url: URL) {
  const copy = new URL(url);
  if (!copy.pathname.endsWith("/")) copy.pathname += "/";
  return copy;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
