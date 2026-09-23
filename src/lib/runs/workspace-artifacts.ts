import { createHash } from "node:crypto";
import {
  googleWorkspaceEffectResultSchema,
  googleWorkspaceEffectTarget,
  parseGoogleWorkspaceActionInput,
} from "@/lib/connectors/google-workspace-actions";
import { listStreamEvents } from "@/lib/events/store";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { parseEffectReceiptV2 } from "@/lib/tools/effect-receipt-v2";
import { toolInputSha256 } from "@/lib/tools/execution-scope";

const MAX_RUN_WORKSPACE_ARTIFACTS = 64;

const GOOGLE_CREATE_TOOLS = Object.freeze({
  "google.docs.create": {
    kind: "document",
    resourceType: "google_document",
    editorSegment: "document",
  },
  "google.sheets.create": {
    kind: "spreadsheet",
    resourceType: "google_spreadsheet",
    editorSegment: "spreadsheets",
  },
  "google.slides.create": {
    kind: "presentation",
    resourceType: "google_presentation",
    editorSegment: "presentation",
  },
} as const);

type GoogleCreateToolId = keyof typeof GOOGLE_CREATE_TOOLS;

export type RunWorkspaceArtifact = Readonly<{
  executionId: string;
  sequence: number;
  provider: "google_workspace";
  kind: "document" | "spreadsheet" | "presentation";
  resourceId: string;
  title: string;
  openUrl: string;
  createdAt: string;
}>;

/**
 * Rebuild Google-native creation results from the governed execution ledger.
 *
 * Provider output is never accepted as sufficient proof. The record must be an
 * exact owner-scoped, live create with a valid v2 effect receipt; its parsed
 * input, provider acknowledgement and read-after-write digest must all bind to
 * the same execution before a safe editor URL is derived locally.
 */
export async function listRunWorkspaceArtifacts(
  runId: string,
  owner: { tenantId: string; actorId: string },
): Promise<RunWorkspaceArtifact[]> {
  const events = await listStreamEvents(`run:${runId}`, {
    tenantId: owner.tenantId,
    limit: 2_000,
    order: "asc",
  });
  const references = new Map<string, {
    executionId: string;
    sequence: number;
    createdAt: string;
    toolId: GoogleCreateToolId;
  }>();

  for (const event of events) {
    if (event.type !== "run.tool") continue;
    const executionId = exactString(event.payload.executionId, 240);
    const toolId = googleCreateToolId(event.payload.toolId);
    if (
      !executionId ||
      !toolId ||
      event.payload.status !== "executed" ||
      event.payload.dryRun === true ||
      references.has(executionId)
    ) {
      continue;
    }
    references.set(executionId, {
      executionId,
      sequence: event.seq,
      createdAt: event.at,
      toolId,
    });
    if (references.size >= MAX_RUN_WORKSPACE_ARTIFACTS) break;
  }
  if (!references.size) return [];

  const executions = await getToolExecutionsByIds([...references.keys()], {
    tenantId: owner.tenantId,
  });
  const executionById = new Map(
    executions.map((execution) => [execution.id, execution]),
  );
  const artifacts = [...references.values()].map((reference) => {
    const execution = executionById.get(reference.executionId);
    if (
      !execution ||
      execution.actorId !== owner.actorId ||
      execution.tenantId !== owner.tenantId ||
      execution.toolId !== reference.toolId ||
      execution.status !== "executed" ||
      execution.dryRun ||
      !execution.effectReceipt
    ) {
      return null;
    }

    try {
      const input = parseGoogleWorkspaceActionInput(
        reference.toolId,
        execution.input,
      );
      const output = googleWorkspaceEffectResultSchema.parse(execution.output);
      const receipt = parseEffectReceiptV2(execution.effectReceipt, {
        executionId: execution.id,
        tenantId: owner.tenantId,
        actorId: owner.actorId,
        toolId: reference.toolId,
      });
      const definition = GOOGLE_CREATE_TOOLS[reference.toolId];
      const target = googleWorkspaceEffectTarget(
        reference.toolId,
        input,
        execution.id,
      );
      const resourceIdSha256 = sha256(output.resourceId);
      const providerAcknowledgementSha256 = canonicalJsonSha256({
        provider: "google_workspace",
        connectionId: output.connectionId,
        toolId: reference.toolId,
        resourceType: definition.resourceType,
        resourceIdSha256,
        providerAcknowledgement: output.providerAcknowledgement,
        observedTargetStateSha256: target.expectedTargetStateSha256,
      });
      if (
        !receipt ||
        output.toolId !== reference.toolId ||
        output.connectionId !== input.connectionId ||
        output.resourceType !== definition.resourceType ||
        output.resourceIdSha256 !== resourceIdSha256 ||
        output.observedTargetStateSha256 !== target.expectedTargetStateSha256 ||
        output.providerAcknowledgementSha256 !== providerAcknowledgementSha256 ||
        output.providerAcknowledgementId !==
          `google_workspace_ack_${providerAcknowledgementSha256.slice(0, 43)}` ||
        receipt.targetType !== target.targetType ||
        receipt.targetId !== target.targetId ||
        receipt.inputSha256 !== toolInputSha256(input) ||
        receipt.expectedTargetStateSha256 !== target.expectedTargetStateSha256 ||
        receipt.observedTargetStateSha256 !== target.expectedTargetStateSha256 ||
        receipt.providerAcknowledgement !== output.providerAcknowledgement ||
        receipt.providerAcknowledgementId !== output.providerAcknowledgementId ||
        receipt.providerAcknowledgementSha256 !== output.providerAcknowledgementSha256 ||
        receipt.verificationState !== "verified" ||
        receipt.verificationReasonCode !== "state_matched"
      ) {
        return null;
      }

      const title = exactString(input.title, 255);
      if (!title) return null;
      return {
        executionId: execution.id,
        sequence: reference.sequence,
        provider: "google_workspace",
        kind: definition.kind,
        resourceId: output.resourceId,
        title,
        openUrl: googleEditorUrl(definition.editorSegment, output.resourceId),
        createdAt: execution.completedAt || reference.createdAt,
      } satisfies RunWorkspaceArtifact;
    } catch {
      return null;
    }
  });

  return artifacts
    .filter((artifact): artifact is RunWorkspaceArtifact => artifact !== null)
    .sort((left, right) => left.sequence - right.sequence);
}

function googleCreateToolId(value: unknown): GoogleCreateToolId | undefined {
  return typeof value === "string" && value in GOOGLE_CREATE_TOOLS
    ? value as GoogleCreateToolId
    : undefined;
}

function googleEditorUrl(
  segment: "document" | "spreadsheets" | "presentation",
  resourceId: string,
) {
  if (!/^[A-Za-z0-9_.:@-]{1,1024}$/u.test(resourceId)) {
    throw new Error("Google Workspace resource ID is invalid.");
  }
  return `https://docs.google.com/${segment}/d/${encodeURIComponent(resourceId)}/edit`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function exactString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= maxLength ? text : "";
}
