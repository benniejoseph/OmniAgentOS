import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureExtractionReceipt, finalizeCaptureExtraction } from "@/lib/capture/extraction";
import { parseWorkspaceLibraryItem } from "@/lib/library/contracts";
import { formatRunReviewEvidence, type ReviewToolObservation } from "@/lib/orchestration/review-evidence";
import type { SecurityContext } from "@/lib/security/types";

const mocks = vi.hoisted(() => ({ item: vi.fn(), asset: vi.fn(), extraction: vi.fn() }));
vi.mock("@/lib/library/store", () => ({ getWorkspaceLibraryItem: mocks.item, listWorkspaceLibrary: vi.fn() }));
vi.mock("@/lib/capture/assets", () => ({ getCaptureAssetForRequest: mocks.asset, getCaptureAssetExtractionForRequest: mocks.extraction }));
vi.mock("@/lib/http/rate-limit", () => ({ checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) }));

import { executeGovernedTool } from "@/lib/tools/executor";

const context: SecurityContext = { tenantId: "tenant-library-review", actorId: "owner", role: "admin", source: "session" };
const item = parseWorkspaceLibraryItem({
  schemaVersion: 1, id: "library:capture_asset:fixture", tenantId: context.tenantId, kind: "document", sourceAuthority: "capture_asset", sourceId: "fixture",
  title: "Acceptance fixture", summary: "Synthetic source", sourceLabel: "Capture", status: "ready", tags: [],
  scope: { visibility: "user_private", ownerActorId: context.actorId, workspaceId: null, projectId: null, missionId: null, workItemId: null, permissionBasis: "owner" },
  currentVersion: { versionId: "version:fixture", versionNumber: 1, contentSha256: "a".repeat(64), byteCount: 100, mediaType: "text/plain", sourceRevisionId: "revision:fixture", createdAt: "2026-10-14T00:00:00Z" },
  versionCount: 1, citationRefs: ["capture-asset:fixture"], links: [{ kind: "knowledge_document", id: "document-fixture", label: "Fixture", href: null }],
  openHref: "/api/capture/assets/fixture?content=1", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z",
});
let dataDirectory: string;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-library-review-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDirectory);
  vi.stubEnv("DATABASE_URL", "");
  vi.clearAllMocks();
  mocks.item.mockResolvedValue(item);
  mocks.asset.mockResolvedValue({ status: "indexed", contentSha256: item.currentVersion.contentSha256, knowledgeDocumentId: "document-fixture" });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("governed Library page review", () => {
  it.each([
    { name: "canonical citation", chunkId: "chunk-fixture", valid: true },
    { name: "malformed citation", chunkId: "chunk with spaces", valid: false },
    { name: "secret-shaped citation", chunkId: "sk-abcdefghijklmnopqrstuvwxyz", valid: false },
  ])("preserves complete delivery only for a $name through the actual executor", async ({ chunkId, valid }) => {
    const extraction = finalizeCaptureExtraction({ sourceKind: "document", format: "txt", state: "completed", warningCodes: [],
      units: [{ label: "Acceptance", locator: { kind: "text_span" }, content: "Acceptance requires completed exercises and written signoff." }],
    });
    mocks.extraction.mockResolvedValue({ evidenceAvailable: true, receipt: captureExtractionReceipt(extraction),
      units: extraction.units.map(unit => ({ ...unit, evidenceUnitId: "evidence-unit:fixture", knowledgeChunkId: chunkId })),
    });
    const execution = await executeGovernedTool({ toolId: "app.library.show", input: {
      libraryItemId: item.id, contentPage: { versionId: item.currentVersion.versionId, contentSha256: item.currentVersion.contentSha256 },
    }, context, requireReadOnly: true, dryRun: false });
    expect(execution.record).toMatchObject({ status: "executed", dryRun: false, approvalRequired: false, tenantId: context.tenantId, actorId: context.actorId });
    expect(execution.result).toMatchObject({ contentPage: { units: [{ citationToken: valid ? `[knowledge:${chunkId}]` : "[redacted]" }] } });
    const observation: ReviewToolObservation = {
      executionId: execution.record.id, toolId: execution.record.toolId, status: execution.record.status,
      dryRun: execution.record.dryRun, approvalRequired: execution.record.approvalRequired,
      modelOutput: JSON.stringify({ provenance: "tool_result", trust: "untrusted_data", data: {
        executionId: execution.record.id, status: execution.record.status, dryRun: execution.record.dryRun,
        approvalRequired: execution.record.approvalRequired, result: execution.result,
        admissibleEvidenceIds: valid ? [`knowledge:${chunkId}`] : [],
      } }),
    };
    expect(observation.modelOutput.length).toBeLessThanOrEqual(8_000);
    const review = JSON.parse(formatRunReviewEvidence({ commandContext: "", retrievedContext: "", liveWebContext: "", citationSources: [], toolObservations: [observation] }));
    if (valid) {
      expect(review.executions.libraryReads).toHaveLength(1);
      expect(review.executions.libraryReads[0].deliveryCoverage).toMatchObject({ wholeExtractedTextDeliveredToWriter: true, incompleteReasons: [] });
    } else {
      expect(review.executions.libraryReads).toHaveLength(0);
      expect(review.executions.observations[0].result.libraryPageValidation).toBe("incomplete_invalid_page");
      if (chunkId.startsWith("sk-")) expect(observation.modelOutput).not.toContain(chunkId);
    }
  });
});
