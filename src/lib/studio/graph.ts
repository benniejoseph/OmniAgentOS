import {
  studioCanonicalJson,
  studioGraphSchema,
  type StudioAsset,
  type StudioEdge,
  type StudioExecutionScope,
  type StudioGraph,
  type StudioIssue,
  type StudioNode,
  type StudioParameterValue,
  type StudioPort,
  type StudioPortType,
} from "./contracts";

/** The registry can carry additional pricing/availability information; graph rules need only this subset. */
export type GraphCapability = {
  id: string;
  schemaVersion: number;
  mediaKind: "image" | "video";
  available?: boolean;
  unavailableReason?: string;
  maxOutputs: number;
  inputRoles: readonly {
    portId: string;
    role: string;
    mediaKind: "image" | "video" | "audio";
    required: boolean;
    maxConnections: number;
  }[];
  parameters: readonly {
    key: string;
    type: string;
    default?: StudioParameterValue;
    options?: readonly (
      | StudioParameterValue
      | { value: StudioParameterValue; label?: string }
    )[];
    min?: number;
    max?: number;
  }[];
};
export type StudioPreviousResult = {
  configurationHash: string;
  outputAssets: StudioAsset[];
  inputAssets?: StudioAsset[];
  runId?: string;
};
export type StudioPlan = {
  nodeIds: string[];
  dependencies: Record<string, string[]>;
  reusedNodeIds: string[];
  issues: StudioIssue[];
  effectivePrompts: Record<string, string>;
  configurationHashes: Record<string, string>;
};
const mediaTypes: StudioPortType[] = [
  "image",
  "video",
  "audio",
  "images",
  "videos",
  "audio_collection",
];
function output(id: string, label: string, type: StudioPortType): StudioPort {
  return {
    id,
    label,
    type,
    direction: "output",
    multiple: true,
    required: false,
  };
}
function input(
  id: string,
  label: string,
  type: StudioPortType,
  multiple = false,
  required = false,
): StudioPort {
  return { id, label, type, direction: "input", multiple, required };
}
export function getNodePorts(
  node: StudioNode,
  capabilities: readonly GraphCapability[],
): StudioPort[] {
  if (node.type === "prompt") return [output("text", "Prompt", "text")];
  if (node.type === "note") return [];
  if (node.type === "asset") {
    const type = node.config.assetMediaType?.startsWith("video/")
      ? "video"
      : node.config.assetMediaType?.startsWith("audio/")
        ? "audio"
        : "image";
    return [
      output(type, `${type[0].toUpperCase()}${type.slice(1)} reference`, type),
    ];
  }
  if (node.type === "output")
    return [
      {
        ...input("media", "Gallery", "image", true, true),
        accepts: mediaTypes,
      },
    ];
  const capability = capabilities.find(
    (c) => c.id === node.config.capabilityId,
  );
  const ports: StudioPort[] = [input("prompt", "Prompt", "text")];
  for (const role of capability?.inputRoles ?? []) {
    ports.push({
      ...input(
        role.portId,
        role.role.replaceAll("_", " "),
        role.mediaKind,
        role.maxConnections > 1,
        role.required,
      ),
      role: role.role,
    });
  }
  return [
    ...ports,
    ...(node.type === "image"
      ? [
          output("selected", "Selected image", "image"),
          output("images", "All images", "images"),
        ]
      : [
          output("video", "Video", "video"),
          output("videos", "All videos", "videos"),
        ]),
  ];
}
export const portsForNode = getNodePorts;
function issue(
  code: string,
  message: string,
  extra: Partial<StudioIssue> = {},
): StudioIssue {
  return { code, message, severity: "error", ...extra };
}

export function connectionIssue(
  graph: StudioGraph,
  edge: StudioEdge,
  capabilities: readonly GraphCapability[],
  ignoredEdgeId?: string,
): StudioIssue | undefined {
  const source = graph.nodes.find((n) => n.id === edge.source);
  const target = graph.nodes.find((n) => n.id === edge.target);
  if (!source || !target)
    return issue("missing_node", "Both ends of a connection must exist.", {
      edgeId: edge.id,
    });
  if (source.id === target.id)
    return issue("self_connection", "A node cannot connect to itself.", {
      nodeId: target.id,
      edgeId: edge.id,
    });
  const from = getNodePorts(source, capabilities).find(
    (p) => p.id === edge.sourcePort && p.direction === "output",
  );
  const to = getNodePorts(target, capabilities).find(
    (p) => p.id === edge.targetPort && p.direction === "input",
  );
  if (!from || !to)
    return issue(
      "missing_port",
      "This model or node does not have that input or output. Reconnect the edge.",
      { nodeId: target.id, edgeId: edge.id },
    );
  if (!(to.accepts ?? [to.type]).includes(from.type))
    return issue(
      "incompatible_port",
      `Connect ${to.accepts?.join(", ") ?? to.type} to ${to.label}. ${from.label} provides ${from.type}.`,
      { nodeId: target.id, portId: to.id, edgeId: edge.id },
    );
  const others = graph.edges.filter((e) => e.id !== (ignoredEdgeId ?? edge.id));
  if (
    others.some(
      (e) =>
        e.source === edge.source &&
        e.sourcePort === edge.sourcePort &&
        e.target === edge.target &&
        e.targetPort === edge.targetPort,
    )
  )
    return issue("duplicate_connection", "These ports are already connected.", {
      edgeId: edge.id,
    });
  if (
    !to.multiple &&
    others.some(
      (e) => e.target === edge.target && e.targetPort === edge.targetPort,
    )
  )
    return issue(
      "single_input",
      `${to.label} accepts one connection. Remove the current connection first.`,
      { nodeId: target.id, portId: to.id, edgeId: edge.id },
    );
  const visited = new Set<string>();
  const pending = [target.id];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source.id)
      return issue(
        "cycle",
        "This connection would create a loop. Flows must move in one direction.",
        { edgeId: edge.id },
      );
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of others.filter((e) => e.source === id))
      pending.push(next.target);
  }
}
export function isValidStudioConnection(
  graph: StudioGraph,
  edge: StudioEdge,
  capabilities: readonly GraphCapability[],
) {
  return !connectionIssue(graph, edge, capabilities);
}
export function dependenciesFor(graph: StudioGraph, nodeId: string): string[] {
  return [
    ...new Set(
      graph.edges
        .filter((e) => e.target === nodeId)
        .sort(edgeOrder)
        .map((e) => e.source),
    ),
  ];
}
function edgeOrder(a: StudioEdge, b: StudioEdge) {
  return a.order - b.order || a.id.localeCompare(b.id);
}
export function topologicalOrder(graph: StudioGraph): string[] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const incoming = new Map(
    graph.nodes.map((n) => [
      n.id,
      new Set(dependenciesFor(graph, n.id).filter((id) => ids.has(id))),
    ]),
  );
  const ready = graph.nodes
    .filter((n) => !incoming.get(n.id)?.size)
    .map((n) => n.id);
  const result: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    result.push(id);
    for (const [next, parents] of incoming)
      if (
        parents.delete(id) &&
        !parents.size &&
        !result.includes(next) &&
        !ready.includes(next)
      )
        ready.push(next);
  }
  return result;
}
export function scopeNodeIds(
  graph: StudioGraph,
  scope: StudioExecutionScope,
): string[] {
  const wanted = new Set<string>();
  const visit = (id: string) => {
    if (wanted.has(id)) return;
    wanted.add(id);
    for (const parent of dependenciesFor(graph, id)) visit(parent);
  };
  if (scope.mode === "flow")
    graph.nodes
      .filter((n) => n.enabled && ["image", "video", "output"].includes(n.type))
      .forEach((n) => visit(n.id));
  else if (scope.nodeId) {
    if (scope.mode === "to-here") visit(scope.nodeId);
    else wanted.add(scope.nodeId);
  }
  return topologicalOrder(graph).filter((id) => wanted.has(id));
}
export function effectivePrompt(graph: StudioGraph, nodeId: string): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return "";
  const edge = graph.edges.find(
    (e) => e.target === nodeId && e.targetPort === "prompt",
  );
  const connected = edge && graph.nodes.find((n) => n.id === edge.source);
  // Connected prompt replaces the local primary prompt; an instruction is explicitly appended once.
  const primary =
    connected?.type === "prompt"
      ? (connected.config.prompt ?? "")
      : (node.config.prompt ?? "");
  return node.config.instruction?.trim()
    ? `${primary}${primary ? "\n\n" : ""}${node.config.instruction}`
    : primary;
}
/** Semantic identity contains only ancestors of this node. The text is intentionally collision-free. */
export function executionIdentity(graph: StudioGraph, nodeId: string): string {
  const ids = new Set<string>();
  const visit = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const p of dependenciesFor(graph, id)) visit(p);
  };
  visit(nodeId);
  const nodes = graph.nodes
    .filter((n) => ids.has(n.id) && n.type !== "note")
    .map((n) => {
      const config = { ...n.config };
      // A connected prompt replaces local primary text. The original is retained in draft/history only.
      if (
        graph.edges.some((e) => e.target === n.id && e.targetPort === "prompt")
      )
        delete config.prompt;
      // Choosing this node's output changes downstream consumers, not its generation itself.
      if (
        n.id === nodeId ||
        !graph.edges.some(
          (edge) =>
            edge.source === n.id &&
            ids.has(edge.target) &&
            (edge.sourcePort === "selected" || edge.sourcePort === "video"),
        )
      )
        delete config.selectedOutputId;
      return { id: n.id, type: n.type, enabled: n.enabled, config };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map(({ source, sourcePort, target, targetPort, order }) => ({
      source,
      sourcePort,
      target,
      targetPort,
      order,
    }))
    .sort((a, b) =>
      studioCanonicalJson(a).localeCompare(studioCanonicalJson(b)),
    );
  return studioCanonicalJson({
    schemaVersion: graph.schemaVersion,
    nodes,
    edges,
  });
}
export const freshnessKey = executionIdentity;

/** Matching settings alone cannot reuse a video after its source image was deliberately regenerated. */
export function hasFreshStudioResult(
  graph: StudioGraph,
  nodeId: string,
  results: Record<string, StudioPreviousResult>,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(nodeId)) return false;
  const node = graph.nodes.find((n) => n.id === nodeId);
  const previous = results[nodeId];
  if (
    !node?.enabled ||
    !previous?.outputAssets.length ||
    previous.configurationHash !== executionIdentity(graph, nodeId)
  )
    return false;
  visiting = new Set(visiting).add(nodeId);
  const expected: { id: string; contentSha256?: string }[] = [];
  for (const edge of graph.edges
    .filter((e) => e.target === nodeId && e.targetPort !== "prompt")
    .sort(edgeOrder)) {
    const parent = graph.nodes.find((n) => n.id === edge.source);
    if (!parent?.enabled) return false;
    if (parent.type === "asset") {
      if (!parent.config.assetId) return false;
      expected.push({
        id: parent.config.assetId,
        contentSha256: parent.config.assetVersion,
      });
    } else if (parent.type === "image" || parent.type === "video") {
      if (!hasFreshStudioResult(graph, parent.id, results, visiting))
        return false;
      const assets = results[parent.id].outputAssets;
      if (edge.sourcePort === "selected" || edge.sourcePort === "video") {
        const selected =
          assets.length === 1
            ? assets[0]
            : assets.find((a) => a.id === parent.config.selectedOutputId);
        if (!selected) return false;
        expected.push(selected);
      } else expected.push(...assets);
    }
  }
  const actual = previous.inputAssets ?? [];
  return (
    expected.length === actual.length &&
    expected.every(
      (asset, index) =>
        actual[index].id === asset.id &&
        (!asset.contentSha256 ||
          actual[index].contentSha256 === asset.contentSha256),
    )
  );
}

export function validateGraph(
  graph: StudioGraph,
  capabilities: readonly GraphCapability[],
  options: { scope?: StudioExecutionScope; checkRequired?: boolean } = {},
): StudioIssue[] {
  const parsed = studioGraphSchema.safeParse(graph);
  if (!parsed.success)
    return parsed.error.issues.map((e) =>
      issue("invalid_graph", `${e.path.join(".")}: ${e.message}`),
    );
  const errors: StudioIssue[] = [];
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.id))
      errors.push(
        issue("duplicate_node", "Node IDs must be unique.", { nodeId: n.id }),
      );
    seen.add(n.id);
  }
  seen.clear();
  for (const edge of graph.edges) {
    if (seen.has(edge.id))
      errors.push(
        issue("duplicate_edge", "Connection IDs must be unique.", {
          edgeId: edge.id,
        }),
      );
    seen.add(edge.id);
    const invalid = connectionIssue(graph, edge, capabilities);
    if (invalid) errors.push(invalid);
  }
  if (
    options.scope &&
    options.scope.mode !== "flow" &&
    !graph.nodes.some((n) => n.id === options.scope?.nodeId)
  )
    errors.push(issue("missing_target", "Select a node to run."));
  if (options.checkRequired === false) return errors;
  const included = options.scope
    ? new Set(scopeNodeIds(graph, options.scope))
    : new Set(graph.nodes.filter((n) => n.enabled).map((n) => n.id));
  for (const node of graph.nodes.filter((n) => included.has(n.id))) {
    const at = { nodeId: node.id };
    if (!node.enabled) {
      errors.push(
        issue(
          "disabled_dependency",
          "Enable this required node before running its dependents.",
          at,
        ),
      );
      continue;
    }
    if (node.type === "note") continue;
    if (node.type === "asset" && !node.config.assetId)
      errors.push(
        issue("missing_asset", "Upload or select an existing asset.", at),
      );
    if (node.type === "prompt" && !node.config.prompt?.trim())
      errors.push(
        issue("missing_prompt", "Write a prompt before running this flow.", at),
      );
    if (node.type === "image" || node.type === "video") {
      const cap = capabilities.find((c) => c.id === node.config.capabilityId);
      if (!cap) {
        errors.push(
          issue(
            "missing_capability",
            "Select a supported model and operation.",
            at,
          ),
        );
        continue;
      }
      if (cap.mediaKind !== node.type)
        errors.push(
          issue(
            "capability_type",
            "Choose a model for this node's media type.",
            at,
          ),
        );
      if (cap.available === false)
        errors.push(
          issue(
            "provider_unavailable",
            cap.unavailableReason ||
              "Connect this model in Settings before running.",
            at,
          ),
        );
      if (!effectivePrompt(graph, node.id).trim())
        errors.push(
          issue(
            "missing_prompt",
            "Connect a prompt or write one in this node.",
            { ...at, portId: "prompt" },
          ),
        );
      for (const [key, value] of Object.entries(node.config.parameters)) {
        const field = cap.parameters.find((p) => p.key === key);
        if (!field) {
          errors.push(
            issue(
              "unsupported_parameter",
              `${key} is not supported by this model.`,
              at,
            ),
          );
          continue;
        }
        const values = field.options?.map((v) =>
          typeof v === "object" ? v.value : v,
        );
        if (
          (values && !values.includes(value)) ||
          (field.type === "number" &&
            (typeof value !== "number" ||
              !Number.isFinite(value) ||
              (field.min !== undefined && value < field.min) ||
              (field.max !== undefined && value > field.max))) ||
          (field.type === "boolean" && typeof value !== "boolean") ||
          ((field.type === "text" || field.type === "select") &&
            typeof value !== "string")
        )
          errors.push(
            issue(
              "invalid_parameter",
              `Choose a supported value for ${key}.`,
              at,
            ),
          );
      }
      const count = Number(node.config.parameters.outputCount ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > cap.maxOutputs)
        errors.push(
          issue(
            "output_count",
            `This model allows 1–${cap.maxOutputs} outputs.`,
            at,
          ),
        );
      for (const role of cap.inputRoles) {
        const connections = graph.edges.filter(
          (e) => e.target === node.id && e.targetPort === role.portId,
        );
        if (connections.length > role.maxConnections)
          errors.push(
            issue(
              "reference_limit",
              `Use at most ${role.maxConnections} ${role.role} references.`,
              { ...at, portId: role.portId },
            ),
          );
      }
    }
    for (const p of getNodePorts(node, capabilities).filter(
      (p) => p.direction === "input" && p.required,
    )) {
      if (
        !graph.edges.some((e) => e.target === node.id && e.targetPort === p.id)
      )
        errors.push(
          issue("missing_input", `Connect the ${p.label} input.`, {
            ...at,
            portId: p.id,
          }),
        );
    }
  }
  return errors;
}

export function planExecution(
  graph: StudioGraph,
  scope: StudioExecutionScope,
  capabilities: readonly GraphCapability[],
  previousResults: Record<string, StudioPreviousResult> = {},
): StudioPlan {
  const issues = validateGraph(graph, capabilities, { scope });
  const nodeIds = scopeNodeIds(graph, scope);
  const dependencies: Record<string, string[]> = {};
  const configurationHashes: Record<string, string> = {};
  const prompts: Record<string, string> = {};
  const reusedNodeIds: string[] = [];
  const available = (id: string) =>
    hasFreshStudioResult(graph, id, previousResults);
  for (const id of nodeIds) {
    const node = graph.nodes.find((n) => n.id === id)!;
    dependencies[id] = dependenciesFor(graph, id);
    configurationHashes[id] = executionIdentity(graph, id);
    prompts[id] = effectivePrompt(graph, id);
    const explicitRegeneration =
      scope.regenerate && (scope.mode === "flow" || scope.nodeId === id);
    if (
      ["image", "video"].includes(node.type) &&
      available(id) &&
      !explicitRegeneration
    )
      reusedNodeIds.push(id);
    for (const edge of graph.edges.filter((e) => e.target === id)) {
      const parent = graph.nodes.find((n) => n.id === edge.source);
      if (!parent) continue;
      if (
        scope.mode === "node" &&
        ["image", "video"].includes(parent.type) &&
        !available(parent.id)
      )
        issues.push(
          issue(
            "upstream_required",
            "This input has no matching successful output. Use Run to here to generate it first.",
            { nodeId: id, portId: edge.targetPort },
          ),
        );
      if (
        scope.mode === "node" &&
        parent.type === "asset" &&
        !parent.config.assetId
      )
        issues.push(
          issue("missing_asset", "Select the upstream reference asset first.", {
            nodeId: parent.id,
          }),
        );
      if (
        scope.mode === "node" &&
        parent.type === "prompt" &&
        !parent.config.prompt?.trim()
      )
        issues.push(
          issue("missing_prompt", "Write the connected prompt first.", {
            nodeId: parent.id,
          }),
        );
      const single =
        edge.sourcePort === "selected" || edge.sourcePort === "video";
      if (single && ["image", "video"].includes(parent.type)) {
        const prior = available(parent.id)
          ? previousResults[parent.id]
          : undefined;
        const count =
          prior?.outputAssets.length ??
          Number(parent.config.parameters.outputCount ?? 1);
        if (
          count > 1 &&
          (!parent.config.selectedOutputId ||
            !prior?.outputAssets.some(
              (a) => a.id === parent.config.selectedOutputId,
            ))
        )
          issues.push(
            issue(
              "output_selection_required",
              "Run the upstream generator, then select one result before sending it to this input.",
              { nodeId: parent.id, portId: edge.sourcePort },
            ),
          );
        if (
          count > 1 &&
          scope.regenerate &&
          (scope.mode === "flow" || scope.nodeId === parent.id)
        )
          issues.push(
            issue(
              "output_selection_required",
              "Regenerate these variations first, then select the new output for the next step.",
              { nodeId: parent.id, portId: edge.sourcePort },
            ),
          );
      }
    }
  }
  if (!nodeIds.length && !issues.length)
    issues.push(
      issue("empty_execution", "Add a generator or select a node to run."),
    );
  return {
    nodeIds,
    dependencies,
    reusedNodeIds,
    issues,
    effectivePrompts: prompts,
    configurationHashes,
  };
}

/** Preserves only values accepted by the replacement model and reports every removed/reset field. */
export function switchNodeCapability(
  node: StudioNode,
  next: GraphCapability,
): { node: StudioNode; changes: string[] } {
  const parameters: Record<string, StudioParameterValue> = {};
  const changes: string[] = [];
  for (const field of next.parameters) {
    const current = node.config.parameters[field.key];
    const values = field.options?.map((v) =>
      typeof v === "object" ? v.value : v,
    );
    const valid =
      current !== undefined &&
      (!values || values.includes(current)) &&
      (field.type !== "number" ||
        (typeof current === "number" &&
          (field.min === undefined || current >= field.min) &&
          (field.max === undefined || current <= field.max))) &&
      (field.type !== "boolean" || typeof current === "boolean") &&
      (field.type !== "text" || typeof current === "string");
    if (valid) parameters[field.key] = current;
    else if (field.default !== undefined) {
      parameters[field.key] = field.default;
      if (current !== undefined)
        changes.push(`${field.key} changed to ${String(field.default)}.`);
    }
  }
  for (const key of Object.keys(node.config.parameters))
    if (!next.parameters.some((f) => f.key === key))
      changes.push(`${key} is not supported and was removed.`);
  const config = { ...node.config, capabilityId: next.id, parameters };
  delete config.selectedOutputId;
  return { node: { ...node, config }, changes };
}
