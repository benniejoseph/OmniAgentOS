import { z } from "zod";

export const STUDIO_SCHEMA_VERSION = 1 as const;
export const STUDIO_MAX_NODES = 50;
export const STUDIO_MAX_EDGES = 160;
export const studioIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9:_-]+$/);
export const studioProjectCategorySchema = z.enum([
  "fashion",
  "trading",
  "ai-tech",
  "custom",
]);
export type StudioProjectCategory = z.infer<typeof studioProjectCategorySchema>;
export const studioProjectProfileInputSchema = z
  .object({
    category: studioProjectCategorySchema,
    brandName: z.string().trim().min(1).max(160),
    audience: z.string().trim().max(800).default(""),
    contentPillars: z
      .array(z.string().trim().min(1).max(160))
      .max(12)
      .default([]),
    voice: z.string().trim().max(800).default(""),
    visualStyle: z.string().trim().max(1200).default(""),
    guidelines: z.string().trim().max(2000).default(""),
    channels: z
      .array(
        z
          .object({
            platform: z.string().trim().min(1).max(80),
            handle: z.string().trim().max(160).default(""),
            url: z
              .string()
              .trim()
              .url()
              .max(500)
              .refine(
                (value) => /^https?:\/\//i.test(value),
                "Use an HTTP or HTTPS link.",
              )
              .optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict();
export type StudioProjectProfileInput = z.infer<
  typeof studioProjectProfileInputSchema
>;
export type StudioProjectProfile = StudioProjectProfileInput & {
  projectId: string;
  revision: number;
  updatedAt: string;
};
export type StudioProject = {
  id: string;
  legacyProjectId: string | null;
  title: string;
  status: "draft" | "active" | "completed" | "archived";
  workspaceId: string;
  profile: StudioProjectProfile | null;
};
export const studioProjectContextSchema = studioProjectProfileInputSchema
  .extend({
    projectId: studioIdSchema,
    profileRevision: z.number().int().positive(),
  })
  .strict();
export type StudioProjectContext = z.infer<typeof studioProjectContextSchema>;
export function studioProjectProfileDefaults(
  category: StudioProjectCategory,
  brandName: string,
): StudioProjectProfileInput {
  const defaults: Record<
    StudioProjectCategory,
    Pick<
      StudioProjectProfileInput,
      "contentPillars" | "voice" | "visualStyle" | "guidelines"
    >
  > = {
    fashion: {
      contentPillars: [
        "Outfit inspiration",
        "Style details",
        "Collection stories",
      ],
      voice: "Confident, warm and editorial",
      visualStyle:
        "Clean editorial photography, considered lighting and a consistent palette",
      guidelines:
        "Represent products accurately. Avoid invented product details or claims.",
    },
    trading: {
      contentPillars: [
        "Market education",
        "Trading process",
        "Risk management",
      ],
      voice: "Clear, measured and educational",
      visualStyle: "Legible charts and restrained financial graphics",
      guidelines:
        "Educational content. Do not invent market data, promise returns or imply a trade recommendation.",
    },
    "ai-tech": {
      contentPillars: [
        "AI explainers",
        "Practical workflows",
        "Technology ideas",
      ],
      voice: "Curious, clear and practical",
      visualStyle:
        "Modern, readable technology visuals with a simple focal point",
      guidelines:
        "Separate demonstrated capabilities from concepts. Do not invent product claims.",
    },
    custom: { contentPillars: [], voice: "", visualStyle: "", guidelines: "" },
  };
  return {
    category,
    brandName,
    audience: "",
    channels: [],
    ...defaults[category],
  };
}
export const studioNodeTypeSchema = z.enum([
  "prompt",
  "asset",
  "image",
  "video",
  "output",
  "note",
]);
export type StudioNodeType = z.infer<typeof studioNodeTypeSchema>;
export type StudioMediaKind = "image" | "video" | "audio";
export type StudioPortType =
  "text" | StudioMediaKind | "images" | "videos" | "audio_collection";
export type StudioParameterValue = string | number | boolean;
export const studioNodeConfigSchema = z
  .object({
    prompt: z.string().max(8000).optional(),
    instruction: z.string().max(4000).optional(),
    capabilityId: z.string().max(180).optional(),
    parameters: z
      .record(
        z.string().max(80),
        z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
      )
      .default({}),
    assetId: studioIdSchema.optional(),
    assetMediaType: z.string().max(100).optional(),
    assetVersion: z.string().max(160).optional(),
    selectedOutputId: studioIdSchema.optional(),
  })
  .strict();
export type StudioNodeConfig = z.infer<typeof studioNodeConfigSchema>;
export const studioNodeSchema = z
  .object({
    id: studioIdSchema,
    type: studioNodeTypeSchema,
    title: z.string().max(160),
    position: z
      .object({
        x: z.number().finite().min(-100000).max(100000),
        y: z.number().finite().min(-100000).max(100000),
      })
      .strict(),
    enabled: z.boolean().default(true),
    config: studioNodeConfigSchema,
  })
  .strict();
export type StudioNode = z.infer<typeof studioNodeSchema>;
export const studioEdgeSchema = z
  .object({
    id: studioIdSchema,
    source: studioIdSchema,
    sourcePort: z.string().min(1).max(80),
    target: studioIdSchema,
    targetPort: z.string().min(1).max(80),
    order: z.number().int().min(0).max(160).default(0),
  })
  .strict();
export type StudioEdge = z.infer<typeof studioEdgeSchema>;
export const studioGraphSchema = z
  .object({
    schemaVersion: z.literal(STUDIO_SCHEMA_VERSION),
    projectContext: studioProjectContextSchema.optional(),
    nodes: z.array(studioNodeSchema).max(STUDIO_MAX_NODES),
    edges: z.array(studioEdgeSchema).max(STUDIO_MAX_EDGES),
  })
  .strict();
export type StudioGraph = z.infer<typeof studioGraphSchema>;
export const studioViewportSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().min(0.1).max(4),
  })
  .strict();
export type StudioViewport = z.infer<typeof studioViewportSchema>;
export const studioScopeSchema = z
  .object({
    mode: z.enum(["node", "to-here", "flow"]),
    nodeId: studioIdSchema.optional(),
    regenerate: z.boolean().default(false),
  })
  .strict();
export type StudioExecutionScope = z.infer<typeof studioScopeSchema>;
export type StudioScope = StudioExecutionScope;
export type StudioIssue = {
  code: string;
  message: string;
  nodeId?: string;
  portId?: string;
  edgeId?: string;
  severity: "error" | "warning";
};
export type StudioPort = {
  id: string;
  label: string;
  direction: "input" | "output";
  type: StudioPortType;
  accepts?: StudioPortType[];
  multiple: boolean;
  required: boolean;
  role?: string;
};
export type StudioAsset = {
  id: string;
  filename: string;
  mediaType: string;
  byteCount: number;
  contentSha256: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  demo?: boolean;
  contentUrl?: string;
  createdAt?: string;
  origin?: string;
  metadata?: Record<string, unknown>;
};
export type StudioFlow = {
  id: string;
  name: string;
  description: string;
  workspaceId: string;
  projectId: string | null;
  revision: number;
  graph: StudioGraph;
  viewport: StudioViewport;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
export type StudioNodeState =
  | "queued"
  | "submitting"
  | "running"
  | "persisting"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled"
  | "moderated"
  | "uncertain";
export type StudioRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "canceled"
  | "uncertain";
export type StudioAttemptView = {
  id: string;
  submissionKey: string;
  status: StudioNodeState;
  providerRequestId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  cancellationRequestedAt?: string;
};
export type StudioNodeRun = {
  nodeId: string;
  status: StudioNodeState;
  configurationHash: string;
  effectivePrompt: string;
  inputAssets: StudioAsset[];
  outputAssets: StudioAsset[];
  attempts: StudioAttemptView[];
  error?: string;
  errorCode?: string;
  blockedBy?: string[];
  reusedFrom?: string;
  startedAt?: string;
  completedAt?: string;
  progress?: number;
};
export type StudioEstimate = {
  currency: "USD";
  status: "known" | "range" | "unknown";
  estimatedUsd: number | null;
  minimumUsd?: number;
  maximumUsd?: number;
  explanation?: string;
};
export type StudioQuote = {
  id: string;
  flowId: string;
  flowRevision: number;
  snapshotHash: string;
  scope: StudioExecutionScope;
  expiresAt: string;
  estimate: StudioEstimate;
  generationCount: number;
  reusedNodeIds: string[];
  nodeIds: string[];
  issues: StudioIssue[];
  effectivePrompts: Record<string, string>;
  requiresUnknownCostConsent: boolean;
};
export type StudioRun = {
  id: string;
  flowId: string;
  flowRevision: number;
  graph: StudioGraph;
  scope: StudioExecutionScope;
  status: StudioRunState;
  nodes: StudioNodeRun[];
  estimate: StudioEstimate;
  maxCostUsd: number | null;
  maxGenerations: number;
  requestedBy: string;
  cancellationRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};
export type StudioRunEvent = {
  id: string;
  seq: number;
  type: string;
  createdAt: string;
  nodeId?: string;
  message: string;
  status?: StudioNodeState | StudioRunState;
};
export const STUDIO_TERMINAL_NODE_STATES: readonly StudioNodeState[] = [
  "succeeded",
  "failed",
  "blocked",
  "canceled",
  "moderated",
  "uncertain",
];
export const STUDIO_TERMINAL_RUN_STATES: readonly StudioRunState[] = [
  "succeeded",
  "partial",
  "failed",
  "canceled",
  "uncertain",
];

/** Canonical text is compared directly, or SHA-256 hashed server-side. Never use it as a submission identity. */
export function studioCanonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(studioCanonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${studioCanonicalJson(v)}`)
    .join(",")}}`;
}
export function emptyStudioGraph(): StudioGraph {
  return { schemaVersion: 1, nodes: [], edges: [] };
}
export function studioAssetUrl(id: string, download = false) {
  return `/api/capture/assets/${encodeURIComponent(id)}?content=1${download ? "&download=1" : ""}`;
}
