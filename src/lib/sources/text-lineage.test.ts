import { describe, expect, it } from "vitest";
import { chunkText, normalizeTextForChunking } from "@/lib/rag/chunk";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { mergeCanonicalSourceLedger } from "@/lib/sources/store";
import { buildCanonicalTextSourceWrite } from "@/lib/sources/text-lineage";
import { CLAIM_EVIDENCE_PURPOSE_ID } from "@/lib/sources/purposes";

describe("canonical text source lineage", () => {
  it("builds exact chunk evidence without retaining the raw external ID", () => {
    const content = "Alpha decision.\n\nBeta follow-up.";
    const normalizedContent = normalizeTextForChunking(content);
    const externalItemId = "provider-secret-item-42";
    const write = buildCanonicalTextSourceWrite({
      lineage: {
        executionScope: createExecutionScope({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          executingPrincipalType: "system",
          executingPrincipalId: "source-sync",
          workspaceId: "workspace-a",
          correlationId: "sync-1",
          purpose: "connector.sync",
        }),
        connectionId: "connection-a",
        adapterId: "provider.documents",
        externalItemId,
        sourceKind: "document",
        capturedAt: "2026-09-04T00:00:00.000Z",
        permissionGrantIds: ["grant-a"],
      },
      content,
      normalizedContent,
      chunks: chunkText(content),
    });

    expect(JSON.stringify(write.adapterOutput)).not.toContain(externalItemId);
    expect(write.evidenceUnitIdsByChunkIndex).toHaveLength(1);
    expect(write.adapterOutput.allowedPurposeIds).toContain(
      CLAIM_EVIDENCE_PURPOSE_ID,
    );
    expect(write.adapterOutput.evidenceUnits[0].locator).toMatchObject({
      kind: "text_span",
      startOffset: 0,
      endOffsetExclusive: normalizedContent.length,
      containerLength: normalizedContent.length,
    });
    const firstLedger = mergeCanonicalSourceLedger(undefined, write);
    expect(mergeCanonicalSourceLedger(firstLedger, write)).toEqual(firstLedger);
  });

  it("fails closed when a chunk does not match its declared span", () => {
    const content = "One exact passage";
    expect(() =>
      buildCanonicalTextSourceWrite({
        lineage: {
          executionScope: createExecutionScope({
            tenantId: "tenant-a",
            initiatingActorId: "actor-a",
            executingPrincipalType: "user",
            executingPrincipalId: "actor-a",
            correlationId: "ingest-1",
            purpose: "knowledge.ingest",
          }),
          connectionId: "first_party.ingest",
          adapterId: "asael.ingest",
          externalItemId: "item-a",
          sourceKind: "document",
          capturedAt: "2026-09-04T00:00:00.000Z",
        },
        content,
        normalizedContent: content,
        chunks: [
          {
            index: 0,
            content: "different",
            characterStart: 0,
            characterEnd: content.length,
          },
        ],
      }),
    ).toThrow("exact text-span locator");
  });
});
