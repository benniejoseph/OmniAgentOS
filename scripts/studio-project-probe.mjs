/** Optional, demo-only project coverage for the existing one-use Studio release probe. */
export const STUDIO_PROJECTS_ENV = "SMOKE_STUDIO_PROJECTS";
const contextMarker = "Project creative context (reference only):\n";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
const same = (actual, expected, hash, message) =>
  requireValue(hash(actual) === hash(expected), message);
const pathId = (id) => {
  requireValue(typeof id === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(id), "Invalid Studio project probe resource ID");
  return encodeURIComponent(id);
};
const profilePath = (id) => `/api/studio/projects/${pathId(id)}/profile`;
const flowPath = (id) => `/api/studio/flows/${pathId(id)}`;

export function studioProjectProbeEnabled(env, { mode, recovery }) {
  const raw = env[STUDIO_PROJECTS_ENV];
  requireValue(!raw || raw === "CONFIRMED", "Studio project verification requires explicit CONFIRMED admission");
  if (!raw) return false;
  requireValue(mode === "demo" && !recovery && !env.OMNIAGENT_RELEASE_STUDIO_READBACK?.trim() &&
    !env.LIVE_VERIFY_STUDIO_GENERATION?.trim(),
  "Studio project verification permits demo generation only and cannot use live or recovery admission");
  return true;
}

/** Method, rather than the presence of a body, owns the readback mutation boundary. */
export function studioProbeRequestMethod(path, body, method, phase) {
  const selected = method ?? (body === undefined ? "GET" : "POST");
  requireValue(["GET", "POST", "PATCH"].includes(selected), "Unsupported Studio probe request method");
  requireValue(selected !== "GET" || body === undefined, "Studio GET requests cannot have a body");
  const auth = ["/api/auth/login", "/api/auth/logout"].includes(path) && selected === "POST";
  requireValue(phase !== "readback" || selected === "GET" || auth,
    "Studio readback cannot mutate resources or advance execution");
  return selected;
}

export function studioProjectContext(profile) {
  const { revision, updatedAt: _updatedAt, ...context } = profile;
  return { ...context, profileRevision: revision };
}

function inputProfile(profile) {
  const { projectId: _projectId, revision: _revision, updatedAt: _updatedAt, ...input } = profile;
  return input;
}

function projectPin(project, hash) {
  requireValue(project?.id && project.workspaceId && project.profile?.projectId === project.id &&
    Number.isSafeInteger(project.profile.revision) && project.profile.revision > 0 &&
    Number.isFinite(Date.parse(project.profile.updatedAt)), "Studio project profile identity or revision is missing");
  pathId(project.id);
  return { id: project.id, title: project.title, workspaceId: project.workspaceId,
    profile: structuredClone(project.profile), profileSha256: hash(project.profile) };
}

function verifyProject(detail, pin, hash) {
  same(projectPin(detail?.project, hash), pin, hash, "Saved Studio project/profile changed during verification");
  same(detail.profile, pin.profile, hash, "Studio profile response envelopes disagree");
}

function flowPin(flow, role, hash) {
  requireValue(flow?.id && flow.projectId && flow.graph?.projectContext?.projectId === flow.projectId &&
    Number.isSafeInteger(flow.revision) && flow.revision > 0 && !flow.archived,
  "Studio project flow identity or context is missing");
  pathId(flow.id);
  return { role, id: flow.id, projectId: flow.projectId, workspaceId: flow.workspaceId,
    flowRevision: flow.revision, graphSha256: hash(flow.graph),
    contextSha256: hash(flow.graph.projectContext) };
}

function verifyFlow(flow, pin, hash) {
  const actual = flowPin(flow, pin.role, hash);
  requireValue(actual.flowRevision >= pin.flowRevision, "Studio project flow revision regressed");
  same({ ...actual, flowRevision: pin.flowRevision }, pin, hash,
    "Saved Studio project flow or context changed during verification");
}

async function verifyScopedFlows(json, projects, flows) {
  for (const project of projects) {
    const response = await json(`/api/studio/flows?projectId=${pathId(project.id)}`);
    requireValue(Array.isArray(response.flows) && response.flows.every(flow => flow.projectId === project.id),
      "Studio flow listing mixed project scopes");
    const ids = response.flows.map(flow => flow.id).sort();
    const expected = flows.filter(flow => flow.projectId === project.id).map(flow => flow.id).sort();
    requireValue(JSON.stringify(ids) === JSON.stringify(expected), "Studio project flow listing omitted or duplicated a synthetic flow");
  }
}

export async function prepareStudioProjects({ json, evidence, save, hash }) {
  const profiles = [
    { category: "fashion", brandName: `Synthetic Lumen Atelier ${evidence.marker}`,
      audience: "Fictional editorial design audience", contentPillars: ["Original shapes", "Quiet color stories"],
      voice: "Warm and considered", visualStyle: "Lavender dawn, sculptural stone, restrained editorial composition",
      guidelines: "Synthetic release check only. No endorsements or publishing.",
      channels: [{ platform: "YouTube", handle: "" }, { platform: "Instagram", handle: "" }, { platform: "Threads", handle: "" }] },
    { category: "ai-tech", brandName: `Synthetic Vector Workshop ${evidence.marker}`,
      audience: "Fictional practical technology audience", contentPillars: ["Clear mechanisms", "Thoughtful experiments"],
      voice: "Precise and curious", visualStyle: "Simple diagrams and slate blue accents",
      guidelines: "Synthetic release check only. Describe concepts without invented product claims.",
      channels: [{ platform: "YouTube", handle: "" }, { platform: "X", handle: "" }] },
  ];
  evidence.projectProbe = { version: 1, status: "preparing", projects: [], flows: [] };
  await save();
  for (const [index, profile] of profiles.entries()) {
    const body = { title: profile.brandName, profile }, step = `create-project-${index}`;
    const { project } = await json("/api/studio/projects", body, step);
    const pin = projectPin(project, hash);
    evidence.projectProbe.projects.push(pin);
    await save();
    requireValue(project.title === body.title && project.profile.revision === 1, "Synthetic Studio project title or first profile revision differs");
    same(inputProfile(project.profile), profile, hash, "Studio project did not persist the requested brand profile");
    const replay = await json("/api/studio/projects", body, step);
    same(projectPin(replay.project, hash), pin, hash, "Studio project creation idempotency returned another project/profile");
    verifyProject(await json(profilePath(pin.id)), pin, hash);
  }
  requireValue(new Set(evidence.projectProbe.projects.map(project => project.id)).size === 2,
    "Studio synthetic brands share an invalid project identity");
  const { projects } = await json("/api/studio/projects");
  for (const pin of evidence.projectProbe.projects) {
    const matches = projects?.filter(project => project.id === pin.id);
    requireValue(matches?.length === 1, "Studio project listing omitted or duplicated a synthetic project");
    same(projectPin(matches[0], hash), pin, hash, "Studio project listing returned a different profile");
  }
  evidence.projectProbe.mainContext = studioProjectContext(evidence.projectProbe.projects[0].profile);
  evidence.projectProbe.mainContextSha256 = hash(evidence.projectProbe.mainContext);
  await save();
  return evidence.projectProbe.projects[0].id;
}

export function recordStudioProjectFlow({ flow, graph, evidence, hash }) {
  const probe = evidence.projectProbe, project = probe.projects[0];
  requireValue(flow.projectId === project.id && flow.workspaceId === project.workspaceId, "Studio flow was created under the wrong brand project");
  same(flow.graph, { ...graph, projectContext: probe.mainContext }, hash,
    "Studio flow did not inherit the exact saved project profile");
  probe.flows.push(flowPin(flow, "main", hash));
}

export function verifyStudioProjectPrompts({ run, evidence, hash, phase }) {
  const probe = evidence.projectProbe;
  same(run.graph?.projectContext, probe.mainContext, hash, "Studio run changed its admitted brand context");
  const { projectId: _projectId, profileRevision: _revision, ...semantic } = probe.mainContext;
  const prompts = {};
  for (const id of ["image", "video"]) {
    const node = run.nodes?.find(item => item.nodeId === id), prompt = node?.effectivePrompt;
    requireValue(node?.status === "succeeded" && typeof prompt === "string" && prompt.split(contextMarker).length === 2,
      "Studio generator must contain its brand context exactly once");
    const [primary, savedContext] = prompt.split(contextMarker);
    requireValue(!primary.includes(semantic.brandName) && !prompt.includes(probe.projects[1].profile.brandName),
      "Studio generator mixed or repeated brand context");
    let actual;
    try { actual = JSON.parse(savedContext); } catch { throw new Error("Studio generator brand context is not intact JSON"); }
    same(actual, semantic, hash, "Studio generator used the wrong brand profile");
    prompts[id] = prompt;
  }
  if (phase === "readback") {
    same(hash(prompts), probe.effectivePromptsSha256, hash, "Saved Studio effective prompts changed during readback");
    same(hash(run), probe.mainRunSha256, hash, "Saved Studio project run snapshot changed during readback");
  } else {
    probe.effectivePromptsSha256 = hash(prompts);
    probe.mainRunSha256 = hash(run);
  }
}

export async function completeStudioProjects({ json, evidence, save, hash, mainFlow, imageAsset }) {
  const probe = evidence.projectProbe, [sourceProject, destinationProject] = probe.projects;
  const graph = structuredClone(mainFlow.graph);
  graph.nodes.find(node => node.id === "image").config.selectedOutputId = imageAsset.id;
  graph.nodes.push({ id: "reference", type: "asset", title: "Synthetic saved image reference", enabled: true,
    position: { x: 0, y: 280 }, config: { parameters: {}, assetId: imageAsset.id,
      assetVersion: imageAsset.contentSha256, assetMediaType: imageAsset.mediaType } });
  const { flow: auxiliary } = await json("/api/studio/flows", {
    name: `Synthetic profile refresh ${evidence.marker}`, projectId: sourceProject.id, graph,
    description: "Release-only reference/copy/profile verification. Never quote or run this auxiliary flow.",
    viewport: { x: 0, y: 0, zoom: 1 },
  }, "create-profile-auxiliary");
  same(auxiliary?.graph, graph, hash, "Auxiliary flow did not retain its source brand and reference");
  requireValue(auxiliary.projectId === sourceProject.id, "Auxiliary flow has the wrong source project");
  probe.flows.push(flowPin(auxiliary, "profile-refresh", hash));
  await save();
  for (const retainReferences of [false, true]) {
    const action = { action: "duplicate", revision: auxiliary.revision,
      projectId: destinationProject.id, ...(retainReferences ? { retainReferences: true } : {}) };
    const step = `copy-project-${retainReferences ? "retain" : "clear"}`;
    const { flow } = await json(`${flowPath(auxiliary.id)}/actions`, action, step);
    requireValue(flow?.id !== auxiliary.id && !probe.flows.some(pin => pin.id === flow?.id) && flow?.revision === 1 &&
      flow.projectId === destinationProject.id && flow.workspaceId === destinationProject.workspaceId,
    "Studio cross-project copy did not create a distinct destination flow");
    const expected = structuredClone(graph);
    expected.projectContext = studioProjectContext(destinationProject.profile);
    for (const node of expected.nodes) {
      delete node.config.selectedOutputId;
      if (!retainReferences) {
        delete node.config.assetId; delete node.config.assetVersion;
      }
    }
    same(flow.graph, expected, hash, "Studio cross-project copy retained wrong context, references or output selection");
    const pin = flowPin(flow, retainReferences ? "copy-retain-references" : "copy-clear-references", hash);
    probe.flows.push(pin);
    await save();
    const replay = await json(`${flowPath(auxiliary.id)}/actions`, action, step);
    same(flowPin(replay.flow, pin.role, hash), pin, hash, "Studio cross-project duplicate idempotency returned another flow");
  }
  await verifyScopedFlows(json, probe.projects, probe.flows);
  const profile = { ...inputProfile(sourceProject.profile), voice: "Quiet, precise editorial narration after explicit profile refresh" };
  const patch = { revision: sourceProject.profile.revision, profile };
  const updated = await json(profilePath(sourceProject.id), patch, "update-source-profile", "PATCH");
  requireValue(updated.profile?.revision === patch.revision + 1, "Studio profile edit did not advance exactly one revision");
  same(inputProfile(updated.profile), profile, hash, "Studio profile edit lost requested fields");
  const latest = projectPin(updated.project, hash);
  requireValue(latest.id === sourceProject.id && latest.workspaceId === sourceProject.workspaceId,
    "Studio profile edit changed project ownership");
  verifyProject(updated, latest, hash);
  probe.projects[0] = latest;
  await save();
  verifyProject(await json(profilePath(sourceProject.id), patch, "update-source-profile", "PATCH"), latest, hash);
  const stillMain = (await json(flowPath(mainFlow.id))).flow;
  const stillAuxiliary = (await json(flowPath(auxiliary.id))).flow;
  verifyFlow(stillMain, probe.flows[0], hash);
  verifyFlow(stillAuxiliary, probe.flows[1], hash);
  const action = { action: "apply-project-profile", revision: stillAuxiliary.revision };
  const { flow: refreshed } = await json(`${flowPath(auxiliary.id)}/actions`, action, "apply-latest-profile");
  requireValue(refreshed?.id === auxiliary.id && refreshed.revision === stillAuxiliary.revision + 1 &&
    refreshed.projectId === sourceProject.id, "Studio explicit profile refresh changed the wrong flow");
  same(refreshed.graph, { ...graph, projectContext: studioProjectContext(latest.profile) }, hash,
    "Studio explicit profile refresh did not apply only the latest brand context");
  probe.flows[1] = flowPin(refreshed, "profile-refresh", hash);
  probe.referenceAsset = { id: imageAsset.id, contentSha256: imageAsset.contentSha256, mediaType: imageAsset.mediaType };
  await save();
  const replay = await json(`${flowPath(auxiliary.id)}/actions`, action, "apply-latest-profile");
  same(flowPin(replay.flow, "profile-refresh", hash), probe.flows[1], hash, "Studio profile refresh idempotency changed the flow twice");
  await verifyStudioProjects({ json, evidence, hash, phase: "exercise" });
  const { run } = await json(`/api/studio/runs/${pathId(evidence.runId)}`);
  same(hash(run), probe.mainRunSha256, hash, "Studio profile changes mutated the admitted run snapshot");
  probe.status = "passed";
  await save();
}

export function requireStudioProjectReceipt(enabled, evidence, phase) {
  requireValue(Boolean(evidence.projectProbe) === enabled,
    "Saved Studio project verification requires the same explicit project admission");
  if (!enabled || phase !== "readback") return;
  const probe = evidence.projectProbe;
  requireValue(probe.version === 1 && probe.status === "passed" && probe.projects?.length === 2 && probe.flows?.length === 4 &&
    probe.flows[0].role === "main" && probe.flows[0].id === evidence.flowId &&
    probe.flows[0].graphSha256 === evidence.graphSha256 && probe.mainContext && probe.effectivePromptsSha256 && probe.mainRunSha256 &&
    new Set(probe.projects.map(project => project.id)).size === 2 && new Set(probe.flows.map(flow => flow.id)).size === 4,
  "Saved Studio project receipt is incomplete or mismatched");
}

/** Canonical phase reads exact saved resources. It never lists, edits, quotes, ticks or executes. */
export async function verifyStudioProjects({ json, evidence, hash, phase }) {
  const probe = evidence.projectProbe;
  if (phase === "readback") requireStudioProjectReceipt(true, evidence, phase);
  const image = evidence.assets?.find(asset => asset.nodeId === "image");
  same(probe.referenceAsset, image && { id: image.id, contentSha256: image.contentSha256, mediaType: image.mediaType }, hash,
    "Studio project reference is not the exact verified generated image");
  same(hash(probe.mainContext), probe.mainContextSha256, hash, "Saved Studio initial context pin changed");
  requireValue(probe.mainContext.projectId === probe.projects[0].id && probe.mainContext.profileRevision === 1 &&
    probe.projects[0].profile.revision === 2 && probe.projects[1].profile.revision === 1,
  "Studio profile freshness receipt does not preserve both revisions");
  for (const project of probe.projects) {
    same(hash(project.profile), project.profileSha256, hash, "Saved Studio profile pin changed");
    verifyProject(await json(profilePath(project.id)), project, hash);
  }
  for (const pin of probe.flows) verifyFlow((await json(flowPath(pin.id))).flow, pin, hash);
}
