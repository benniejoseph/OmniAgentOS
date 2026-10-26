import {
  studioCanonicalJson,
  studioProjectContextSchema,
} from "./contracts";
import { StudioError, type StudioRecordKind } from "./server-types";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Keep the persisted graph readable by the preceding strict graph schema.
 * Its flow writers preserve sibling fields; its runner preserves value fields
 * and uses the already admitted effective prompts. Hydration is local to this
 * record: a run must never acquire context from a newer flow or project profile.
 */
function graphContainer(value: unknown, encode: boolean): unknown {
  if (!object(value) || !object(value.graph)) return value;
  const { studioProjectContext: savedContext, graph, ...fields } = value;
  const { projectContext: inlineContext, ...plainGraph } = graph;
  if (
    savedContext !== undefined &&
    inlineContext !== undefined &&
    studioCanonicalJson(savedContext) !== studioCanonicalJson(inlineContext)
  )
    throw new StudioError(
      "The saved creative context is inconsistent. Reload the flow.",
      409,
      "studio_context_integrity",
    );
  const context = inlineContext !== undefined ? inlineContext : savedContext;
  if (context === undefined) return value;
  const checked = studioProjectContextSchema.safeParse(context);
  if (!checked.success)
    throw new StudioError(
      "The saved creative context is incomplete. Reload the flow.",
      409,
      "studio_context_integrity",
    );
  return encode
    ? { ...fields, graph: plainGraph, studioProjectContext: checked.data }
    : { ...fields, graph: { ...plainGraph, projectContext: checked.data } };
}

function transform(kind: StudioRecordKind, body: unknown, encode: boolean) {
  if (kind === "flow") return graphContainer(body, encode);
  if (kind === "run" && object(body))
    return { ...body, value: graphContainer(body.value, encode) };
  return body;
}

export function encodeStudioRecord(kind: StudioRecordKind, body: unknown) {
  return transform(kind, body, true);
}

export function decodeStudioRecord<T>(kind: StudioRecordKind, body: unknown): T {
  return transform(kind, body, false) as T;
}
