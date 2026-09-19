import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  googleWorkspaceEffectTarget,
  type GoogleWorkspaceEffectResult,
} from "@/lib/connectors/google-workspace-actions";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { buildEffectReceiptV2 } from "@/lib/tools/effect-receipt-v2";
import { toolInputSha256 } from "@/lib/tools/execution-scope";

const mocks = vi.hoisted(() => ({
  listStreamEvents: vi.fn(),
  getToolExecutionsByIds: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  listStreamEvents: mocks.listStreamEvents,
}));

vi.mock("@/lib/tools/audit-store", () => ({
  getToolExecutionsByIds: mocks.getToolExecutionsByIds,
}));

import { listRunWorkspaceArtifacts } from "@/lib/runs/workspace-artifacts";

const tenantId = "tenant-workspace-artifact";
const actorId = "actor-workspace-artifact";

describe("run Google Workspace artifact projection", () => {
  beforeEach(() => {
    mocks.listStreamEvents.mockReset();
    mocks.getToolExecutionsByIds.mockReset();
  });

  it("projects a receipt-bound Google Doc and derives its editor URL", async () => {
    const record = googleCreateRecord({
      executionId: "execution-google-doc",
      toolId: "google.docs.create",
      input: {
        title: "Service Cloud transformation proposal",
        blocks: [
          { type: "heading", level: 1, text: "Executive summary" },
          { type: "paragraph", text: "A practical AI service transformation." },
        ],
      },
      resourceType: "google_document",
      resourceId: "google-doc-abc_123",
    });
    mocks.listStreamEvents.mockResolvedValue([
      runToolEvent(record.id, record.toolId, 9),
    ]);
    mocks.getToolExecutionsByIds.mockResolvedValue([record]);

    await expect(listRunWorkspaceArtifacts("run-google-doc", {
      tenantId,
      actorId,
    })).resolves.toEqual([{
      executionId: record.id,
      sequence: 9,
      provider: "google_workspace",
      kind: "document",
      resourceId: "google-doc-abc_123",
      title: "Service Cloud transformation proposal",
      openUrl:
        "https://docs.google.com/document/d/google-doc-abc_123/edit",
      createdAt: "2026-09-19T08:31:00.000Z",
    }]);
  });

  it("supports native Sheets and multi-slide presentations", async () => {
    const sheet = googleCreateRecord({
      executionId: "execution-google-sheet",
      toolId: "google.sheets.create",
      input: {
        title: "AI rollout tracker",
        sheetName: "Plan",
        values: [["Phase", "Owner"], ["Pilot", "Bennie"]],
      },
      resourceType: "google_spreadsheet",
      resourceId: "sheet-1",
    });
    const slides = googleCreateRecord({
      executionId: "execution-google-slides",
      toolId: "google.slides.create",
      input: {
        title: "AIForce client pitch",
        slides: [
          { title: "A better service cloud", body: "AIForce + Salesforce" },
          { title: "Next steps", bullets: ["Discovery", "Pilot"] },
        ],
      },
      resourceType: "google_presentation",
      resourceId: "slides-2",
    });
    mocks.listStreamEvents.mockResolvedValue([
      runToolEvent(sheet.id, sheet.toolId, 2),
      runToolEvent(slides.id, slides.toolId, 3),
    ]);
    mocks.getToolExecutionsByIds.mockResolvedValue([sheet, slides]);

    const artifacts = await listRunWorkspaceArtifacts("run-workspace", {
      tenantId,
      actorId,
    });
    expect(artifacts.map(({ kind, openUrl }) => ({ kind, openUrl }))).toEqual([
      {
        kind: "spreadsheet",
        openUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      },
      {
        kind: "presentation",
        openUrl: "https://docs.google.com/presentation/d/slides-2/edit",
      },
    ]);
  });

  it("rejects sibling ownership and tampered provider evidence", async () => {
    const sibling = googleCreateRecord({
      executionId: "execution-sibling",
      toolId: "google.docs.create",
      input: { title: "Sibling doc", bodyText: "Private" },
      resourceType: "google_document",
      resourceId: "sibling-doc",
      recordActorId: "actor-sibling",
    });
    const tampered = googleCreateRecord({
      executionId: "execution-tampered",
      toolId: "google.docs.create",
      input: { title: "Owner doc", bodyText: "Original" },
      resourceType: "google_document",
      resourceId: "owner-doc",
    });
    const tamperedRecord = {
      ...tampered,
      output: {
        ...tampered.output,
        resourceId: "attacker-doc",
      },
    };
    mocks.listStreamEvents.mockResolvedValue([
      runToolEvent(sibling.id, sibling.toolId, 4),
      runToolEvent(tampered.id, tampered.toolId, 5),
    ]);
    mocks.getToolExecutionsByIds.mockResolvedValue([sibling, tamperedRecord]);

    await expect(listRunWorkspaceArtifacts("run-tampered", {
      tenantId,
      actorId,
    })).resolves.toEqual([]);
  });
});

function googleCreateRecord(input: {
  executionId: string;
  toolId: "google.docs.create" | "google.sheets.create" | "google.slides.create";
  input: Record<string, unknown>;
  resourceType: "google_document" | "google_spreadsheet" | "google_presentation";
  resourceId: string;
  recordActorId?: string;
}) {
  const target = googleWorkspaceEffectTarget(
    input.toolId,
    input.input,
    input.executionId,
  );
  const resourceIdSha256 = sha256(input.resourceId);
  const providerAcknowledgement = "provider_response" as const;
  const providerAcknowledgementSha256 = canonicalJsonSha256({
    provider: "google_workspace",
    toolId: input.toolId,
    resourceType: input.resourceType,
    resourceIdSha256,
    providerAcknowledgement,
    observedTargetStateSha256: target.expectedTargetStateSha256,
  });
  const providerAcknowledgementId =
    `google_workspace_ack_${providerAcknowledgementSha256.slice(0, 43)}`;
  const output: GoogleWorkspaceEffectResult = {
    toolId: input.toolId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceIdSha256,
    providerAcknowledgement,
    providerAcknowledgementId,
    providerAcknowledgementSha256,
    observedTargetStateSha256: target.expectedTargetStateSha256,
    verificationState: "verified",
    verificationReasonCode: "state_matched",
  };
  const recordActorId = input.recordActorId || actorId;
  const effectReceipt = buildEffectReceiptV2({
    effectMode: "live",
    reversible: true,
    executionKind: "direct",
    executionId: input.executionId,
    tenantId,
    actorId: recordActorId,
    executingPrincipalType: "user",
    executingPrincipalId: recordActorId,
    workflowRunId: null,
    planId: null,
    planSha256: null,
    planNodeId: null,
    toolId: input.toolId,
    toolContractSha256: "a".repeat(64),
    approvalState: "approved",
    approvalBindingSha256: "b".repeat(64),
    inputSha256: toolInputSha256(input.input),
    idempotencyKeySha256: "c".repeat(64),
    targetType: target.targetType,
    targetId: target.targetId,
    providerAcknowledgement,
    providerAcknowledgementId,
    providerAcknowledgementSha256,
    verificationMethod: "read_after_write",
    verificationState: "verified",
    verificationReasonCode: "state_matched",
    expectedTargetStateSha256: target.expectedTargetStateSha256,
    observedTargetStateSha256: target.expectedTargetStateSha256,
  });
  return {
    id: input.executionId,
    tenantId,
    actorId: recordActorId,
    toolId: input.toolId,
    toolName: "Create Google Workspace file",
    riskLevel: 2,
    status: "executed",
    dryRun: false,
    approvalRequired: true,
    input: input.input,
    output,
    effectReceipt,
    createdAt: "2026-09-19T08:30:00.000Z",
    completedAt: "2026-09-19T08:31:00.000Z",
  };
}

function runToolEvent(executionId: string, toolId: string, seq: number) {
  return {
    id: `event-${seq}`,
    seq,
    streamId: "run:test",
    type: "run.tool",
    tenantId,
    actorId,
    payload: {
      executionId,
      toolId,
      status: "executed",
    },
    at: `2026-09-19T08:30:0${seq}.000Z`,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
