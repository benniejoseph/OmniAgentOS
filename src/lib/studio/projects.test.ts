import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import * as projectServices from "@/lib/app-services/projects";
import { createProject } from "@/lib/projects/store";
import {
  createStudioProject,
  getStudioProjectProfile,
  listStudioProjects,
  updateStudioProjectProfile,
} from "./projects";
import {
  createStudioFlow,
  getStudioRun,
  listStudioFlows,
  quoteStudioFlow,
  studioFlowAction,
  submitStudioRun,
  updateStudioFlow,
} from "./service";
import { studioOwner } from "./authority";
import { withStudioTransaction } from "./store";
import { effectivePrompt, executionIdentity, validateGraph } from "./graph";
import {
  emptyStudioGraph,
  studioProjectProfileDefaults,
  studioProjectProfileInputSchema,
} from "./contracts";
import { STUDIO_CAPABILITIES } from "./capabilities";
import { createStudioTemplate } from "./templates";

vi.mock("./providers", async (original) => ({
  ...(await original<typeof import("./providers")>()),
  resolveStudioCapabilities: async () =>
    STUDIO_CAPABILITIES.filter((cap) => cap.demo),
}));
const context: SecurityContext = {
  tenantId: "studio-projects-test",
  actorId: "owner@example.test",
  source: "session",
  role: "operator",
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.test",
    sessionId: "test",
    tenantName: "Test",
  },
};
const other: SecurityContext = {
  ...context,
  actorId: "other@example.test",
  auth: {
    ...context.auth!,
    userId: "22222222-2222-4222-8222-222222222222",
    email: "other@example.test",
  },
};
const key = () => randomUUID();
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "studio-projects-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", directory);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const profile = (name = "Example fashion") =>
  studioProjectProfileDefaults("fashion", name);
async function project(name = "Fashion") {
  return createStudioProject(
    context,
    { title: name, profile: profile(name) },
    key(),
  );
}

describe("Studio project creative context", () => {
  it("creates through canonical project service, replays once, lists ordinary projects, and keeps actors isolated", async () => {
    const input = { title: "Fashion", profile: profile() },
      requestKey = key();
    const [first, replay] = await Promise.all([
      createStudioProject(context, input, requestKey),
      createStudioProject(context, input, requestKey),
    ]);
    expect(first.id).toBe(replay.id);
    expect(first.profile?.revision).toBe(1);
    await expect(
      createStudioProject(
        context,
        { ...input, profile: profile("Changed") },
        requestKey,
      ),
    ).rejects.toMatchObject({ code: "studio_idempotency_conflict" });
    await createProject({
      tenantId: context.tenantId,
      actorId: context.actorId,
      title: "Ordinary project",
      objective: "Existing work",
    });
    const projects = await listStudioProjects(context);
    expect(projects).toHaveLength(2);
    expect(
      projects.find((p) => p.title === "Ordinary project")?.profile,
    ).toBeNull();
    expect(await listStudioProjects(other)).toEqual([]);
    await expect(
      getStudioProjectProfile(other, first.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createStudioFlow(other, { name: "Foreign", projectId: first.id }, key()),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("recovers profile initialization after canonical project creation loses its acknowledgement", async () => {
    const input = { title: "Recoverable", profile: profile("Recoverable") },
      requestKey = key();
    const actual = projectServices.createProjectService;
    const spy = vi
      .spyOn(projectServices, "createProjectService")
      .mockImplementationOnce(async (...args) => {
        await actual(...args);
        throw new Error("Simulated disconnect after canonical creation");
      });
    await expect(
      createStudioProject(context, input, requestKey),
    ).rejects.toThrow("Simulated disconnect");
    spy.mockRestore();
    expect(await listStudioProjects(context)).toHaveLength(1);
    expect((await listStudioProjects(context))[0].profile).toBeNull();
    const recovered = await createStudioProject(context, input, requestKey);
    expect(recovered.profile?.revision).toBe(1);
    expect(await listStudioProjects(context)).toHaveLength(1);
  });
  it("revisions and replays profiles without changing already admitted quotes or run snapshots", async () => {
    const brand = await project();
    const graph = createStudioTemplate(
      "image-to-video",
      STUDIO_CAPABILITIES.filter((cap) => cap.demo),
      brand.profile!,
    );
    const flow = await createStudioFlow(
      context,
      { name: "One creative", graph, projectId: brand.id },
      key(),
    );
    expect(flow.graph.projectContext?.profileRevision).toBe(1);
    const prompt = effectivePrompt(flow.graph, "image");
    expect(prompt.match(/Project creative context/g)).toHaveLength(1);
    const scope = { mode: "flow", regenerate: false };
    const quote = await quoteStudioFlow(
      context,
      flow.id,
      { revision: 1, scope },
      key(),
    );
    expect(quote.effectivePrompts.image).toBe(prompt);
    const changed = { ...profile("A new brand"), voice: "Sparse and poetic" },
      requestKey = key();
    const saved = await updateStudioProjectProfile(
      context,
      brand.id,
      { revision: 1, profile: changed },
      requestKey,
    );
    expect(saved.profile?.revision).toBe(2);
    expect(
      (
        await updateStudioProjectProfile(
          context,
          brand.id,
          { revision: 1, profile: changed },
          requestKey,
        )
      ).profile?.revision,
    ).toBe(2);
    await expect(
      updateStudioProjectProfile(
        context,
        brand.id,
        { revision: 1, profile: changed },
        key(),
      ),
    ).rejects.toMatchObject({ code: "studio_profile_revision_conflict" });
    const run = await submitStudioRun(
      context,
      flow.id,
      { quoteId: quote.id, scope, maxCostUsd: 0, maxGenerations: 2 },
      key(),
    );
    expect(run.graph).toEqual(flow.graph);
    expect(run.nodes.find((n) => n.nodeId === "image")?.effectivePrompt).toBe(
      prompt,
    );
    const refreshed = await studioFlowAction(
      context,
      flow.id,
      { action: "apply-project-profile", revision: 1 },
      key(),
    );
    expect(refreshed.graph.projectContext?.profileRevision).toBe(2);
    expect(executionIdentity(refreshed.graph, "image")).not.toBe(
      executionIdentity(flow.graph, "image"),
    );
    expect((await getStudioRun(context, run.id)).run.graph).toEqual(flow.graph);
    const cosmetic = structuredClone(refreshed.graph);
    cosmetic.projectContext!.profileRevision += 1;
    expect(executionIdentity(cosmetic, "image")).toBe(
      executionIdentity(refreshed.graph, "image"),
    );
    await expect(
      submitStudioRun(
        context,
        flow.id,
        { quoteId: quote.id, scope, maxCostUsd: 0, maxGenerations: 2 },
        key(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateStudioFlow(
        context,
        flow.id,
        {
          revision: 2,
          graph: {
            ...refreshed.graph,
            projectContext: {
              ...refreshed.graph.projectContext!,
              voice: "Injected",
            },
          },
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: "studio_project_context_immutable" });
  });
  it("copies into destination profile, clears result selections and references, and explicitly assigns loose flows", async () => {
    const source = await project("Fashion"),
      destination = await project("Trading");
    const graph = createStudioTemplate(
      "product-scene",
      STUDIO_CAPABILITIES.filter((cap) => cap.demo),
    );
    graph.nodes.find((n) => n.id === "product")!.config = {
      parameters: {},
      assetId: "source-asset",
      assetVersion: "version",
      assetMediaType: "image/png",
    };
    graph.nodes.find((n) => n.id === "image")!.config.selectedOutputId =
      "prior-result";
    const flow = await createStudioFlow(
      context,
      { name: "Copy source", projectId: source.id, graph },
      key(),
    );
    const requestKey = key(),
      action = { action: "duplicate", revision: 1, projectId: destination.id };
    const copy = await studioFlowAction(context, flow.id, action, requestKey);
    expect(
      (await studioFlowAction(context, flow.id, action, requestKey)).id,
    ).toBe(copy.id);
    expect(copy.projectId).toBe(destination.id);
    expect(copy.graph.projectContext?.brandName).toBe("Trading");
    expect(
      copy.graph.nodes.find((n) => n.id === "product")!.config.assetId,
    ).toBeUndefined();
    expect(
      copy.graph.nodes.find((n) => n.id === "image")!.config.selectedOutputId,
    ).toBeUndefined();
    const retained = await studioFlowAction(
      context,
      flow.id,
      { ...action, retainReferences: true },
      key(),
    );
    expect(
      retained.graph.nodes.find((n) => n.id === "product")!.config.assetId,
    ).toBe("source-asset");
    const foreign = await createStudioProject(
      other,
      { title: "Private", profile: profile() },
      key(),
    );
    await expect(
      studioFlowAction(
        context,
        flow.id,
        { ...action, projectId: foreign.id },
        key(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const loose = await createStudioFlow(context, { name: "Loose" }, key());
    const assigned = await studioFlowAction(
      context,
      loose.id,
      { action: "assign-project", revision: 1, projectId: destination.id },
      key(),
    );
    expect(assigned.projectId).toBe(destination.id);
    expect(assigned.graph.projectContext?.brandName).toBe("Trading");
    await expect(
      studioFlowAction(
        context,
        flow.id,
        { action: "assign-project", revision: 1, projectId: destination.id },
        key(),
      ),
    ).rejects.toMatchObject({ code: "studio_flow_already_assigned" });
  });
  it.each([
    ["video/mp4", "video"],
    ["audio/mpeg", "audio"],
  ])("preserves connected %s reference ports while clearing copied media", async (mediaType, sourcePort) => {
    const source = await project("Source"), destination = await project("Destination");
    const graph = emptyStudioGraph();
    graph.nodes = [
      { id: "reference", type: "asset", title: "Reference", enabled: true, position: { x: 0, y: 0 }, config: { parameters: {}, assetId: "source-media", assetVersion: "source-version", assetMediaType: mediaType } },
      { id: "gallery", type: "output", title: "Gallery", enabled: true, position: { x: 300, y: 0 }, config: { parameters: {} } },
    ];
    graph.edges = [{ id: "reference-gallery", source: "reference", sourcePort, target: "gallery", targetPort: "media", order: 0 }];
    const flow = await createStudioFlow(context, { name: "Connected media", projectId: source.id, graph }, key());
    const copy = await studioFlowAction(context, flow.id, { action: "duplicate", revision: 1, projectId: destination.id }, key());
    expect(copy.graph.nodes[0].config).toEqual({ parameters: {}, assetMediaType: mediaType });
    expect(copy.graph.edges).toEqual(graph.edges);
    expect(validateGraph(copy.graph, [], { checkRequired: false })).toEqual([]);
    expect(validateGraph(copy.graph, []).some(issue => issue.code === "missing_port")).toBe(false);
    await expect(updateStudioFlow(context, copy.id, { revision: copy.revision, graph: copy.graph }, key())).resolves.toMatchObject({ revision: 2 });
  });
  it("lists all 200 active flows, filters before the bound, and applies the same active cap to copies", async () => {
    const brand = await project();
    const base = await createStudioFlow(
      context,
      { name: "Old project flow", projectId: brand.id },
      key(),
    );
    await withStudioTransaction(studioOwner(context), async (tx) => {
      for (let i = 0; i < 199; i++)
        await tx.put("flow", `seed-${i}`, {
          ...base,
          id: `seed-${i}`,
          projectId: null,
          graph: emptyStudioGraph(),
        });
      for (let i = 0; i < 30; i++)
        await tx.put(
          "flow",
          `archive-${i}`,
          { ...base, id: `archive-${i}`, archived: true },
          { state: "archived" },
        );
    });
    expect(await listStudioFlows(context)).toHaveLength(200);
    expect(await listStudioFlows(context, brand.id)).toHaveLength(1);
    expect(await listStudioFlows(context, null)).toHaveLength(199);
    await expect(
      createStudioFlow(context, { name: "Beyond cap" }, key()),
    ).rejects.toMatchObject({ code: "studio_flow_limit" });
    await expect(
      studioFlowAction(
        context,
        base.id,
        { action: "duplicate", revision: 1 },
        key(),
      ),
    ).rejects.toMatchObject({ code: "studio_flow_limit" });
    const archived = await studioFlowAction(
      context,
      "seed-0",
      { action: "archive", revision: 1 },
      key(),
    );
    await updateStudioFlow(
      context,
      archived.id,
      { revision: archived.revision, name: "Archived still" },
      key(),
    );
    await expect(
      createStudioFlow(context, { name: "Reuses capacity" }, key()),
    ).resolves.toMatchObject({ name: "Reuses capacity" });
  });
  it("accepts platform-only channels, bounds context, and rejects non-web links", () => {
    expect(
      studioProjectProfileInputSchema.parse({
        ...profile(),
        channels: [{ platform: "Threads" }],
      }).channels[0].handle,
    ).toBe("");
    expect(
      studioProjectProfileInputSchema.safeParse({
        ...profile(),
        channels: [{ platform: "X", url: "javascript:alert(1)" }],
      }).success,
    ).toBe(false);
    expect(
      studioProjectProfileInputSchema.safeParse({
        ...profile(),
        audience: "x".repeat(801),
      }).success,
    ).toBe(false);
  });
});
