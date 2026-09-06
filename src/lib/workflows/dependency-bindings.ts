import type {
  WorkflowNodeInputV1,
} from "@/lib/workflows/node-contract";
import type { WorkflowPlanNodeInputBinding } from "@/lib/workflows/types";

const MAX_BINDINGS_PER_NODE = 16;
const MAX_BOUND_ARTIFACT_CHARS = 8_000;
const SAFE_TARGET_ROOTS = new Set([
  "body",
  "content",
  "data",
  "description",
  "input",
  "message",
  "payload",
  "prompt",
  "query",
  "text",
  "title",
]);
const UNSAFE_PATH_SEGMENTS = new Set([
  "__proto__",
  "authorization",
  "command",
  "constructor",
  "credential",
  "credentials",
  "env",
  "headers",
  "host",
  "hostname",
  "method",
  "password",
  "path",
  "prototype",
  "secret",
  "token",
  "url",
]);

export function normalizeWorkflowNodeInputBindings({
  bindings,
  dependencyNodeIds,
  toolIds,
}: {
  bindings: readonly WorkflowPlanNodeInputBinding[] | undefined;
  dependencyNodeIds: readonly string[];
  toolIds: readonly string[];
}) {
  const dependencies = new Set(dependencyNodeIds);
  const tools = new Set(toolIds);
  const seenTargets = new Set<string>();
  return (bindings || []).flatMap((binding) => {
    const normalized: WorkflowPlanNodeInputBinding = {
      dependencyNodeId: binding.dependencyNodeId.trim(),
      targetToolId: binding.targetToolId.trim(),
      targetPath: binding.targetPath.trim(),
      artifactName: binding.artifactName.trim().slice(0, 160),
    };
    const targetKey = `${normalized.targetToolId}\0${normalized.targetPath}`;
    if (
      !dependencies.has(normalized.dependencyNodeId) ||
      !tools.has(normalized.targetToolId) ||
      !safeBindingTargetPath(normalized.targetPath) ||
      seenTargets.has(targetKey)
    ) {
      return [];
    }
    seenTargets.add(targetKey);
    return [normalized];
  }).slice(0, MAX_BINDINGS_PER_NODE);
}

export function resolveWorkflowToolInputBindings({
  input,
  nodeInput,
  toolId,
}: {
  input: Record<string, unknown>;
  nodeInput: WorkflowNodeInputV1;
  toolId: string;
}) {
  const bindings = nodeInput.inputBindings.filter((binding) => binding.targetToolId === toolId);
  if (!bindings.length) return input;
  let resolved = cloneRecord(input);
  for (const binding of bindings) {
    const dependency = nodeInput.dependencies.find(
      (candidate) => candidate.nodeId === binding.dependencyNodeId,
    );
    if (!dependency) {
      throw new Error(`Workflow node ${nodeInput.nodeId} binding is missing dependency ${binding.dependencyNodeId}.`);
    }
    const artifacts = binding.artifactName
      ? dependency.artifacts.filter((artifact) => artifact.name === binding.artifactName)
      : dependency.artifacts;
    if (!artifacts.length) {
      throw new Error(`Workflow node ${nodeInput.nodeId} binding found no matching typed artifact.`);
    }
    const value = artifacts
      .map((artifact) => artifact.content)
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_BOUND_ARTIFACT_CHARS);
    if (!value) {
      throw new Error(`Workflow node ${nodeInput.nodeId} binding resolved to an empty artifact.`);
    }
    resolved = setJsonPointer(resolved, binding.targetPath, value);
  }
  return resolved;
}

export function safeBindingTargetPath(value: string) {
  if (!value.startsWith("/") || value.length > 500) return false;
  const segments = jsonPointerSegments(value);
  return Boolean(
    segments &&
    segments.length >= 1 &&
    segments.length <= 8 &&
    SAFE_TARGET_ROOTS.has(segments[0].toLowerCase()) &&
    segments.every((segment) =>
      segment &&
      segment.length <= 120 &&
      !UNSAFE_PATH_SEGMENTS.has(segment.toLowerCase()) &&
      !/^\d+$/.test(segment)
    ),
  );
}

function setJsonPointer(
  input: Record<string, unknown>,
  pointer: string,
  value: string,
) {
  const segments = jsonPointerSegments(pointer);
  if (!segments || !safeBindingTargetPath(pointer)) {
    throw new Error("Workflow dependency binding target is unsafe.");
  }
  const output = cloneRecord(input);
  let cursor: Record<string, unknown> = output;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      cursor[segment] = next;
      cursor = next;
      continue;
    }
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("Workflow dependency binding cannot traverse a non-object tool input.");
    }
    cursor = existing as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return output;
}

function jsonPointerSegments(value: string) {
  try {
    return value.slice(1).split("/").map((segment) =>
      decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~")
    );
  } catch {
    return undefined;
  }
}

function cloneRecord(value: Record<string, unknown>) {
  return structuredClone(value);
}
