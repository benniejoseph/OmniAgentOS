import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRuntimeClaimEvidenceV1,
  decomposeMaterialClaimSpans,
  publicClaimEvidenceV1,
} from "@/lib/rag/claim-evidence-runtime";
import { chunkText, normalizeTextForChunking } from "@/lib/rag/chunk";
import { createKnowledgeDocument } from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildCanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

describe("runtime claim evidence", () => {
  let dataDirectory = "";
  let previousDataDirectory: string | undefined;
  let previousDatabaseUrl: string | undefined;

  beforeEach(async () => {
    previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
    previousDatabaseUrl = process.env.DATABASE_URL;
    dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-claim-runtime-"));
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

  it("supports only the exact claim found in owner-authorized canonical evidence", async () => {
    const content =
      "The launch date is 12 October 2026. The approved budget is 40 credits.";
    const chunks = chunkText(content);
    const canonicalSourceWrite = buildCanonicalTextSourceWrite({
      lineage: {
        executionScope: createExecutionScope({
          tenantId: "tenant-runtime",
          initiatingActorId: "actor-runtime",
          executingPrincipalType: "user",
          executingPrincipalId: "actor-runtime",
          correlationId: "ingest-runtime",
          purpose: "knowledge.ingest",
        }),
        connectionId: "first-party-knowledge",
        adapterId: "asael.knowledge",
        externalItemId: "plan-runtime",
        sourceKind: "document",
        capturedAt: "2026-09-06T00:00:00.000Z",
      },
      content,
      normalizedContent: normalizeTextForChunking(content),
      chunks,
    });
    const created = await createKnowledgeDocument({
      tenantId: "tenant-runtime",
      title: "Launch plan",
      content,
      chunks,
      canonicalSourceWrite,
    });
    const source = {
      citationId: `knowledge:${created.chunks[0].id}`,
      evidenceId: created.chunks[0].id,
      kind: "knowledge" as const,
      title: "Launch plan",
    };
    const executionScope = createExecutionScope({
      tenantId: "tenant-runtime",
      initiatingActorId: "actor-runtime",
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: "run-runtime",
      purpose: "agent.run.legacy",
    });
    const answer =
      `The launch date is 12 October 2026. [${source.citationId}] ` +
      `A unicorn controls finance. [${source.citationId}]`;
    const result = await buildRuntimeClaimEvidenceV1({
      runId: "run-runtime",
      answerText: answer,
      executionScope,
      citationSources: [source],
      evaluatedAt: "2026-09-06T01:00:00.000Z",
    });

    expect(result.claimEvidenceMap.claims.map((claim) => claim.supportState))
      .toEqual(["supported", "unsupported"]);
    expect(result.claimEvidenceMap.coverage.coverageBps).toBe(5_000);
    expect(result.claimEvidenceMap.evidenceUnits).toHaveLength(1);
    expect(result.structuralVerification.verificationState).toBe("verified");
    const publicReport = publicClaimEvidenceV1(result);
    expect(publicReport.claims).toHaveLength(2);
    expect(JSON.stringify(publicReport)).not.toContain("actor-runtime");
  });

  it("does not expose evidence content to claim matching across actor scope", async () => {
    const content = "The private launch code is 4815.";
    const chunks = chunkText(content);
    const canonicalSourceWrite = buildCanonicalTextSourceWrite({
      lineage: {
        executionScope: createExecutionScope({
          tenantId: "tenant-runtime",
          initiatingActorId: "actor-owner",
          executingPrincipalType: "user",
          executingPrincipalId: "actor-owner",
          correlationId: "ingest-private",
          purpose: "knowledge.ingest",
        }),
        connectionId: "private-knowledge",
        adapterId: "asael.knowledge",
        externalItemId: "private-plan",
        sourceKind: "document",
        capturedAt: "2026-09-06T00:00:00.000Z",
      },
      content,
      normalizedContent: normalizeTextForChunking(content),
      chunks,
    });
    const created = await createKnowledgeDocument({
      tenantId: "tenant-runtime",
      title: "Private plan",
      content,
      chunks,
      canonicalSourceWrite,
    });
    const result = await buildRuntimeClaimEvidenceV1({
      runId: "run-other-actor",
      answerText: content,
      executionScope: createExecutionScope({
        tenantId: "tenant-runtime",
        initiatingActorId: "actor-other",
        executingPrincipalType: "agent",
        executingPrincipalId: "atlas",
        correlationId: "run-other-actor",
        purpose: "agent.run.legacy",
      }),
      citationSources: [{
        citationId: `knowledge:${created.chunks[0].id}`,
        evidenceId: created.chunks[0].id,
        kind: "knowledge",
        title: "Private plan",
      }],
      evaluatedAt: "2026-09-06T01:00:00.000Z",
    });

    expect(result.claimEvidenceMap.evidenceUnits).toEqual([]);
    expect(result.claimEvidenceMap.claims[0].supportState).toBe("unsupported");
  });

  it("binds exact UTF-16 prose spans while excluding headings and code fences", () => {
    const answer = "# Result\n\nAlpha is current. Beta is pending!\n```ts\nconst x = 1;\n```";
    const spans = decomposeMaterialClaimSpans(answer);
    expect(spans.map((span) => answer.slice(span.startUtf16, span.endUtf16Exclusive)))
      .toEqual(["Alpha is current.", "Beta is pending!"]);
  });
});
