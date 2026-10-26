import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import { studioOwner } from "./authority";
import { STUDIO_CAPABILITIES } from "./capabilities";
import {
  studioProjectProfileDefaults,
  type StudioFlow,
  type StudioRun,
} from "./contracts";
import { effectivePrompt, executionIdentity } from "./graph";
import { decodeStudioRecord, encodeStudioRecord } from "./persistence";
import { createStudioProject, updateStudioProjectProfile } from "./projects";
import {
  createStudioFlow,
  getStudioFlow,
  getStudioRun,
  listStudioFlows,
  listStudioRuns,
  quoteStudioFlow,
  studioFlowAction,
  studioHash,
  submitStudioRun,
  updateStudioFlow,
} from "./service";
import type { StoredQuote, StoredRun } from "./server-types";
import { readLocalStudioRecords } from "./store";
import { createStudioTemplate } from "./templates";
import {
  readFlow as readPreviousFlow,
  readRun as readPreviousRun,
} from "./__fixtures__/rollback-d4057c0e";

vi.mock("./providers", async (original) => ({
  ...(await original<typeof import("./providers")>()),
  resolveStudioCapabilities: async () =>
    STUDIO_CAPABILITIES.filter((cap) => cap.demo),
}));
const context: SecurityContext = {
  tenantId: "studio-rollback-test",
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
const scope = { mode: "flow" as const, regenerate: false };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "studio-rollback-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", directory);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const profile = studioProjectProfileDefaults("fashion", "Synthetic brand");
  const project = await createStudioProject(
    context,
    { title: "Synthetic project", profile },
    randomUUID(),
  );
  const graph = createStudioTemplate(
    "image-to-video",
    STUDIO_CAPABILITIES.filter((cap) => cap.demo),
  );
  const input = { name: "Branded flow", projectId: project.id, graph };
  const key = randomUUID();
  const flow = await createStudioFlow(context, input, key);
  return { profile, project, flow, input, key };
}
async function rawRecord(kind: "flow" | "run", id: string) {
  const ledger = await readLocalStudioRecords(studioOwner(context));
  return ledger.records.find((r) => r.kind === kind && r.id === id)!.body;
}
async function previousBinaryWrite(
  change: (ledger: Awaited<ReturnType<typeof readLocalStudioRecords>>) => void,
) {
  const owner = studioOwner(context);
  const ledger = await readLocalStudioRecords(owner);
  change(ledger);
  const file = createHash("sha256")
    .update(JSON.stringify([owner.tenantId, owner.actorId]))
    .digest("hex");
  // Bypass the new codec, just as d4057c0e's raw store writes do.
  await writeFile(path.join(directory, "studio", `${file}.json`), JSON.stringify(ledger));
}

describe("Studio persistence across d4057c0e rollback", () => {
  it("keeps mixed actor lists readable by the exact previous strict flow parser", async () => {
    const ordinary = await createStudioFlow(context, { name: "Original" }, randomUUID());
    const { flow, input, key } = await fixture();
    expect(() => readPreviousFlow(flow)).toThrow("saved flow is incomplete");
    const raw = await readLocalStudioRecords(studioOwner(context));
    const previousList = raw.records.filter((r) => r.kind === "flow").map((r) => readPreviousFlow(r.body));
    expect(previousList.map((f) => f.id).sort()).toEqual([ordinary.id, flow.id].sort());
    expect(previousList.find((f) => f.id === flow.id)?.graph.projectContext).toBeUndefined();
    expect(await getStudioFlow(context, ordinary.id)).toEqual(ordinary);
    expect(await getStudioFlow(context, flow.id)).toEqual(flow);
    expect((await listStudioFlows(context)).find((f) => f.id === flow.id)).toEqual(flow);
    expect(await createStudioFlow(context, input, key)).toEqual(flow);
    expect(await rawRecord("flow", flow.id)).toMatchObject({ studioProjectContext: flow.graph.projectContext });
    expect(await getStudioFlow(context, flow.id)).not.toHaveProperty("studioProjectContext");
  });

  it("retains context through the old flow edit, duplicate and archive spread writers", async () => {
    const { flow } = await fixture();
    const raw = readPreviousFlow(await rawRecord("flow", flow.id));
    const graph = structuredClone(raw.graph);
    graph.nodes.find((n) => n.type === "prompt")!.config.prompt = "Edited during rollback";
    // These spread/override orders are the deployed service.ts update/action writers.
    const edited = { ...raw, graph, name: "Old editor saved", revision: raw.revision + 1, updatedAt: new Date().toISOString() };
    const duplicate = { ...edited, id: `studio_flow_${randomUUID()}`, name: `${edited.name} copy`, revision: 1, archived: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const archived = { ...edited, archived: true, revision: edited.revision + 1, updatedAt: new Date().toISOString() };
    await previousBinaryWrite((ledger) => {
      const record = ledger.records.find((r) => r.kind === "flow" && r.id === flow.id)!;
      record.body = archived;
      record.state = "archived";
      ledger.records.push({ ...record, id: duplicate.id, body: duplicate, state: "active" });
    });
    const restored = await getStudioFlow(context, flow.id);
    expect(restored.archived).toBe(true);
    expect(restored.graph.projectContext).toEqual(flow.graph.projectContext);
    expect(restored.graph.nodes.find((n) => n.type === "prompt")?.config.prompt).toBe("Edited during rollback");
    const copy = await getStudioFlow(context, duplicate.id);
    expect(copy.graph).toEqual(restored.graph);
    expect(copy.archived).toBe(false);
    const update = { revision: copy.revision, name: "Forward editor saved", graph: copy.graph };
    const key = randomUUID();
    const next = await updateStudioFlow(context, copy.id, update, key);
    expect(await updateStudioFlow(context, copy.id, update, key)).toEqual(next);
    expect(readPreviousFlow(await rawRecord("flow", copy.id)).graph.projectContext).toBeUndefined();
    expect(next.graph.projectContext).toEqual(flow.graph.projectContext);
  });

  it("preserves an accepted run's context and exact prompts through old runner writes and later profile changes", async () => {
    const { flow, project, profile } = await fixture();
    const quoteKey = randomUUID();
    const quoteInput = { revision: flow.revision, scope };
    const quote = await quoteStudioFlow(context, flow.id, quoteInput, quoteKey);
    const input = { quoteId: quote.id, scope, maxCostUsd: 0, maxGenerations: 2 };
    const key = randomUUID();
    const run = await submitStudioRun(context, flow.id, input, key);
    const raw = await rawRecord("run", run.id) as StoredRun;
    expect(() => readPreviousRun(run, flow.id)).toThrow("run response did not match");
    expect(readPreviousRun(raw.value, flow.id).graph.projectContext).toBeUndefined();
    expect(raw.value).toMatchObject({ studioProjectContext: run.graph.projectContext });
    expect(raw.value.nodes.map((n) => n.effectivePrompt)).toEqual(run.nodes.map((n) => n.effectivePrompt));
    await previousBinaryWrite((ledger) => {
      const record = ledger.records.find((r) => r.kind === "run" && r.id === run.id)!;
      const oldRun = record.body as StoredRun;
      // The old runner updates this same value, then writes the full StoredRun.
      oldRun.value.status = "canceled";
      oldRun.value.updatedAt = new Date().toISOString();
      oldRun.revision++;
      record.state = "canceled";
    });
    await updateStudioProjectProfile(context, project.id, {
      revision: 1, profile: { ...profile, voice: "A later voice" },
    }, randomUUID());
    expect(await quoteStudioFlow(context, flow.id, quoteInput, quoteKey)).toEqual(quote);
    await studioFlowAction(context, flow.id, { action: "apply-project-profile", revision: flow.revision }, randomUUID());
    const restored = (await getStudioRun(context, run.id)).run;
    expect(restored.graph).toEqual(run.graph);
    expect(restored.nodes).toEqual(run.nodes);
    expect(restored.status).toBe("canceled");
    expect(restored).not.toHaveProperty("studioProjectContext");
    expect(await listStudioRuns(context, flow.id)).toEqual([restored]);
    expect(await submitStudioRun(context, flow.id, input, key)).toEqual(restored);
    const ledger = await readLocalStudioRecords(studioOwner(context));
    expect(ledger.records.find((r) => r.kind === "quote" && r.id === quote.id)?.body).toMatchObject({ value: quote });
  });

  it("does not invent a brand snapshot for runs newly created by the old binary", async () => {
    const { flow } = await fixture();
    const quote = await quoteStudioFlow(context, flow.id, { revision: flow.revision, scope }, randomUUID());
    const run = await submitStudioRun(context, flow.id, {
      quoteId: quote.id, scope, maxCostUsd: 0, maxGenerations: 2,
    }, randomUUID());
    const raw = await rawRecord("run", run.id) as StoredRun;
    const { studioProjectContext: _ignored, ...plainValue } = raw.value as StudioRun & { studioProjectContext?: unknown };
    const old = { ...raw, value: { ...plainValue, id: `studio_run_${randomUUID()}`, status: "canceled" as const,
      nodes: plainValue.nodes.map((node) => ({ ...node,
        effectivePrompt: effectivePrompt(plainValue.graph, node.nodeId),
        configurationHash: executionIdentity(plainValue.graph, node.nodeId),
      })),
    } };
    await previousBinaryWrite((ledger) => {
      const record = ledger.records.find((r) => r.kind === "run" && r.id === run.id)!;
      ledger.records.push({ ...record, id: old.value.id, body: old, state: "canceled" });
    });
    const restored = (await getStudioRun(context, old.value.id)).run;
    expect(restored.graph.projectContext).toBeUndefined();
    expect(executionIdentity(restored.graph, "image")).not.toBe(executionIdentity(flow.graph, "image"));
    expect(restored.nodes).toEqual(old.value.nodes);
    expect(restored.nodes.every((node) => !node.effectivePrompt.includes("Project creative context"))).toBe(true);
    expect((await getStudioFlow(context, flow.id)).graph.projectContext).toEqual(flow.graph.projectContext);
  });

  it("requires a fresh brand-aware quote after an old binary quoted the same flow revision", async () => {
    const { flow } = await fixture();
    const quote = await quoteStudioFlow(context, flow.id, { revision: flow.revision, scope }, randomUUID());
    const previous = readPreviousFlow(await rawRecord("flow", flow.id));
    const oldQuoteId = `studio_quote_${randomUUID()}`;
    await previousBinaryWrite((ledger) => {
      const record = ledger.records.find((r) => r.kind === "quote" && r.id === quote.id)!;
      const old = structuredClone(record.body) as StoredQuote;
      old.value.id = oldQuoteId;
      old.value.snapshotHash = studioHash({
        graph: previous.graph, revision: previous.revision, scope,
        reusable: old.reusable, assetPins: old.assetPins, routes: old.routes, capabilityPins: old.capabilityPins,
      });
      for (const nodeId of old.value.nodeIds) {
        old.value.effectivePrompts[nodeId] = effectivePrompt(previous.graph, nodeId);
        old.configurationHashes[nodeId] = executionIdentity(previous.graph, nodeId);
      }
      ledger.records.push({ ...record, id: oldQuoteId, body: old });
    });
    const input = { quoteId: oldQuoteId, scope, maxCostUsd: 0, maxGenerations: 2 };
    await expect(submitStudioRun(context, flow.id, input, randomUUID()))
      .rejects.toMatchObject({ status: 409, code: "studio_quote_changed" });
    expect((await readLocalStudioRecords(studioOwner(context))).records.filter((r) => r.kind === "run")).toEqual([]);
    const run = await submitStudioRun(context, flow.id, { ...input, quoteId: quote.id }, randomUUID());
    expect(run.graph).toEqual(flow.graph);
    expect(run.nodes.find((n) => n.nodeId === "image")?.effectivePrompt).toBe(quote.effectivePrompts.image);
  });

  it("rejects forged or removed draft context and rejects conflicting/invalid stored context", async () => {
    const { flow } = await fixture();
    const { projectContext: _context, ...plain } = flow.graph;
    await expect(updateStudioFlow(context, flow.id, { revision: 1, graph: plain }, randomUUID()))
      .rejects.toMatchObject({ code: "studio_project_context_immutable" });
    await expect(updateStudioFlow(context, flow.id, { revision: 1, graph: { ...flow.graph,
      projectContext: { ...flow.graph.projectContext!, brandName: "Forged" },
    } }, randomUUID())).rejects.toMatchObject({ code: "studio_project_context_immutable" });
    await expect(updateStudioFlow(context, flow.id, { revision: 1, studioProjectContext: flow.graph.projectContext }, randomUUID()))
      .rejects.toThrow();
    const encoded = encodeStudioRecord("flow", flow) as Record<string, unknown>;
    const conflict = { ...encoded, graph: { ...flow.graph, projectContext: { ...flow.graph.projectContext!, brandName: "Forged" } } };
    for (const transform of [encodeStudioRecord, decodeStudioRecord]) {
      expect(() => transform("flow", conflict)).toThrow("context is inconsistent");
      expect(() => transform("flow", { ...encoded, studioProjectContext: { brandName: "Incomplete" } })).toThrow("context is incomplete");
      expect(() => transform("flow", { ...flow, graph: { ...plain, projectContext: null } })).toThrow("context is incomplete");
    }
    expect(decodeStudioRecord<StudioFlow>("flow", encoded)).toEqual(flow);
    expect(encodeStudioRecord("flow", encoded)).toEqual(encoded);
    expect(await getStudioFlow(context, flow.id)).toEqual(flow);
  });
});
