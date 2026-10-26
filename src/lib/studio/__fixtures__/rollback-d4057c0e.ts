// Frozen runtime validators from deployed d4057c0e1449d83863400cccbc3593dc2eeb48f0.
// Preserve these historical schemas: current-schema imports would hide rollback regressions.
import type { StudioFlow, StudioRun } from "../contracts";

import { z } from "zod";

export const STUDIO_SCHEMA_VERSION = 1 as const;
export const STUDIO_MAX_NODES = 50;
export const STUDIO_MAX_EDGES = 160;
export const studioIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9:_-]+$/);
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
  | "text"
  | StudioMediaKind
  | "images"
  | "videos"
  | "audio_collection";
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

export function readFlow(value: unknown): StudioFlow {
  const v = value as StudioFlow;
  if (
    !v ||
    typeof v.id !== "string" ||
    typeof v.name !== "string" ||
    !Number.isInteger(v.revision) ||
    v.revision < 1 ||
    !studioGraphSchema.safeParse(v.graph).success ||
    !studioViewportSchema.safeParse(v.viewport).success
  )
    throw new Error("The saved flow is incomplete. Refresh before editing.");
  return v;
}
export function readRun(value: unknown, flowId?: string): StudioRun {
  const v = value as StudioRun;
  if (
    !v ||
    typeof v.id !== "string" ||
    (flowId && v.flowId !== flowId) ||
    !Array.isArray(v.nodes) ||
    !studioGraphSchema.safeParse(v.graph).success ||
    ![
      "queued",
      "running",
      "succeeded",
      "partial",
      "failed",
      "canceled",
      "uncertain",
    ].includes(v.status) ||
    v.nodes.some(
      (n) =>
        !n.nodeId ||
        !Array.isArray(n.outputAssets) ||
        !Array.isArray(n.attempts),
    )
  )
    throw new Error(
      "The run response did not match this flow. Refresh its history.",
    );
  return v;
}
