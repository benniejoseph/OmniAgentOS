import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listStreamEvents } from "@/lib/events/store";
import {
  buildContextCompilerV2Automatic,
  buildContextCompilerV2Canary,
  buildContextCompilerV2Shadow,
} from "@/lib/rag/context-compiler-v2";
import {
  appendContextCompilerV2AutomaticEvent,
  appendContextCompilerV2CanaryEvent,
  appendContextCompilerV2ShadowEvent,
  bindAgentRunExecutionScope,
  createAgentRun,
} from "@/lib/runs/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("Context Compiler v2 run event", () => {
  let dataDirectory = "";
  let previousDataDirectory: string | undefined;
  let previousDatabaseUrl: string | undefined;

  beforeEach(async () => {
    previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
    previousDatabaseUrl = process.env.DATABASE_URL;
    dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-context-v2-event-"));
    process.env.OMNIAGENT_DATA_DIR = dataDirectory;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    if (previousDataDirectory === undefined) {
      delete process.env.OMNIAGENT_DATA_DIR;
    } else {
      process.env.OMNIAGENT_DATA_DIR = previousDataDirectory;
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it("persists a scope-bound metadata-only comparison receipt", async () => {
    const scope = createExecutionScope({
      tenantId: "tenant-context-v2",
      initiatingActorId: "actor-context-v2",
      executingPrincipalType: "agent",
      executingPrincipalId: "agent-context-v2",
      correlationId: "correlation-context-v2",
      purpose: "agent.run",
    });
    const run = await createAgentRun({
      tenantId: scope.tenantId,
      actorId: scope.initiatingActorId!,
      mode: "orchestrate",
      prompt: "Use the decision context",
      messages: [{ role: "user", content: "Use the decision context" }],
    });
    await bindAgentRunExecutionScope(run.id, scope, {
      tenantId: scope.tenantId,
    });
    const shadow = buildContextCompilerV2Shadow({
      runId: run.id,
      tenantId: scope.tenantId,
      query: "Use the decision context",
      candidates: [{
        evidenceId: "memory:private-evidence-id",
        itemClass: "claim",
        sourceRevisionId: null,
        score: 0.9,
        authorizationState: "authorized",
        authorizationReason: "authorized",
      }],
      legacySelectedEvidenceIds: ["memory:private-evidence-id"],
      limit: 8,
      asOfTime: "2026-09-06T02:00:00.000Z",
    });

    await appendContextCompilerV2ShadowEvent(run.id, shadow.receipt, {
      tenantId: scope.tenantId,
      executionScope: scope,
    });
    const events = await listStreamEvents(`run:${run.id}`, {
      tenantId: scope.tenantId,
      order: "asc",
    });
    const event = events.find((candidate) =>
      candidate.type === "run.context_compiler_v2.shadow"
    );
    expect(event?.payload).toMatchObject({
      receiptId: shadow.receipt.receiptId,
      comparisonState: "matched",
      selectedCount: 1,
    });
    expect(JSON.stringify(event)).not.toContain("private-evidence-id");
  });

  it("persists the explicit-private canary barrier before disclosure", async () => {
    const scope = createExecutionScope({
      tenantId: "tenant-context-v2-canary",
      initiatingActorId: "actor-context-v2-canary",
      executingPrincipalType: "agent",
      executingPrincipalId: "agent-context-v2-canary",
      correlationId: "correlation-context-v2-canary",
      purpose: "agent.run",
    });
    const run = await createAgentRun({
      tenantId: scope.tenantId,
      actorId: scope.initiatingActorId!,
      mode: "orchestrate",
      prompt: "Use my selected private memory",
      messages: [{ role: "user", content: "Use my selected private memory" }],
    });
    await bindAgentRunExecutionScope(run.id, scope, {
      tenantId: scope.tenantId,
    });
    const canary = buildContextCompilerV2Canary({
      runId: run.id,
      tenantId: scope.tenantId,
      query: "Use my selected private memory",
      candidates: [{
        evidenceId: "memory:private-canary-evidence-id",
        itemClass: "claim",
        sourceRevisionId: null,
        score: 0.9,
        authorizationState: "authorized",
        authorizationReason: "authorized",
      }],
      legacySelectedEvidenceIds: ["memory:private-canary-evidence-id"],
      explicitEvidenceIds: ["memory:private-canary-evidence-id"],
      limit: 8,
      asOfTime: "2026-09-06T02:00:00.000Z",
    });

    await appendContextCompilerV2CanaryEvent(run.id, canary.receipt, {
      tenantId: scope.tenantId,
      executionScope: scope,
    });
    const events = await listStreamEvents(`run:${run.id}`, {
      tenantId: scope.tenantId,
      order: "asc",
    });
    const event = events.find((candidate) =>
      candidate.type === "run.context_compiler_v2.canary"
    );
    expect(event?.payload).toMatchObject({
      mode: "canary",
      receiptId: canary.receipt.receiptId,
      explicitSelectionState: "selected",
      selectedCount: 1,
    });
    expect(JSON.stringify(event)).not.toContain("private-canary-evidence-id");
  });

  it("persists the automatic personal-context barrier before disclosure", async () => {
    const scope = createExecutionScope({
      tenantId: "tenant-context-v2-automatic",
      initiatingActorId: "actor-context-v2-automatic",
      executingPrincipalType: "user",
      executingPrincipalId: "actor-context-v2-automatic",
      correlationId: "correlation-context-v2-automatic",
      purpose: "agent.run",
    });
    const run = await createAgentRun({
      tenantId: scope.tenantId,
      actorId: scope.initiatingActorId!,
      mode: "orchestrate",
      prompt: "Use my relevant saved context",
      messages: [{ role: "user", content: "Use my relevant saved context" }],
    });
    await bindAgentRunExecutionScope(run.id, scope, {
      tenantId: scope.tenantId,
    });
    const automatic = buildContextCompilerV2Automatic({
      runId: run.id,
      tenantId: scope.tenantId,
      query: "Use my relevant saved context",
      candidates: [{
        evidenceId: "memory:automatic-private-evidence-id",
        itemClass: "claim",
        sourceRevisionId: null,
        score: 0.9,
        authorizationState: "authorized",
        authorizationReason: "authorized",
      }],
      legacySelectedEvidenceIds: ["memory:automatic-private-evidence-id"],
      limit: 8,
      asOfTime: "2026-09-06T02:00:00.000Z",
    });

    await appendContextCompilerV2AutomaticEvent(run.id, automatic.receipt, {
      tenantId: scope.tenantId,
      executionScope: scope,
    });
    const events = await listStreamEvents(`run:${run.id}`, {
      tenantId: scope.tenantId,
      order: "asc",
    });
    const event = events.find((candidate) =>
      candidate.type === "run.context_compiler_v2.automatic"
    );
    expect(event?.payload).toMatchObject({
      mode: "automatic",
      receiptId: automatic.receipt.receiptId,
      explicitSelectionState: "automatic",
      selectedCount: 1,
    });
    expect(JSON.stringify(event)).not.toContain(
      "automatic-private-evidence-id",
    );
  });
});
