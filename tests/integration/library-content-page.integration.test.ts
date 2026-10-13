import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showWorkspaceLibraryItemService } from "@/lib/app-services/library";
import * as captureAssets from "@/lib/capture/assets";
import { saveCaptureAsset, updateCaptureAssetStatus } from "@/lib/capture/assets";
import { captureExtractionReceipt, finalizeCaptureExtraction, renderCaptureExtractionUnits, type CaptureStructuredExtraction } from "@/lib/capture/extraction";
import { extractCaptureFile } from "@/lib/capture/files";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import * as libraryStore from "@/lib/library/store";
import { createKnowledgeDocument } from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { buildCanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const tenantId = "library-content-pages";
const email = "content-owner@example.test";
const userId = "abababab-1111-4111-8111-abababababab";
const actorId = `actor:${userId}`;
const context: SecurityContext = { tenantId, actorId: email, role: "operator", source: "session",
  auth: { userId, email, sessionId: "content-page-fixture", tenantName: "Library pages" } };
const caller = createAppServiceCaller({ context });
type PageRequest = NonNullable<Parameters<typeof showWorkspaceLibraryItemService>[1]["contentPage"]>;
type Fixture = Awaited<ReturnType<typeof capturedFixture>>;
const acceptance = "FINAL ACCEPTANCE: all 12 pilot agents attend training including makeups, complete two ticket exercises each, and at least 10 of 12 score 80 percent or more. Sara Okafor accepts only after coaching and retest evidence. An invitation is not completed training.";

function owned<T>(work: () => Promise<T>, value: SecurityContext = context) {
  return runWithDatabaseActorScope(value.tenantId, [value.actorId, ...(value.auth ? [`actor:${value.auth.userId}`] : [])], work);
}

async function docx(paragraphs: string[]) {
  const archive = await JSZip.loadAsync(await readFile("node_modules/mammoth/test/test-data/tables.docx"));
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  archive.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t>${escape(text)}</w:t></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`);
  return archive.generateAsync({ type: "uint8array" });
}

/** Real capture storage and canonical evidence writes; no reader is mocked. */
async function capturedFixture(name: string, bytes: Uint8Array, extraction: CaptureStructuredExtraction, mediaType: string) {
  const scope = createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user", executingPrincipalId: actorId,
    correlationId: `content-page:${name}`, purpose: "capture.fixture" });
  return runWithDatabaseActorScope(tenantId, [actorId, email], async () => {
    const asset = await saveCaptureAsset({ tenantId, actorId, executionScope: scope, filename: name, mediaType, bytes });
    const receipt = captureExtractionReceipt(extraction);
    const content = renderCaptureExtractionUnits(extraction.units);
    let offset = 0;
    const chunks = extraction.units.map((unit) => {
      const characterStart = offset;
      offset += unit.content.length + 2;
      return { index: unit.index, content: unit.content, characterStart, characterEnd: characterStart + unit.content.length,
        locator: unit.locator, label: unit.label,
        metadata: { evidenceLabel: unit.label, extractionReceiptSha256: receipt.receiptSha256,
          structuredSourceKind: receipt.sourceKind, extractionState: receipt.state } };
    });
    const canonicalSourceWrite = buildCanonicalTextSourceWrite({
      lineage: { executionScope: scope, connectionId: "first_party.capture", adapterId: "asael.capture", externalItemId: `asset:${asset.id}`,
        capturedAt: new Date().toISOString(), sourceKind: extraction.sourceKind, visibility: "user_private", sensitivity: "confidential",
        extractorId: extraction.extractorId, extractorVersionId: extraction.extractorVersionId, extractorConfigSha256: extraction.extractorConfigSha256 },
      content, normalizedContent: content, chunks,
    });
    const knowledge = await createKnowledgeDocument({ tenantId, idempotencyKey: `knowledge:${name}`, title: name,
      content, source: `capture:asset:${asset.id}`, sourceType: "file", chunks, canonicalSourceWrite });
    const indexed = await updateCaptureAssetStatus(asset.id, { tenantId, actorId, executionScope: scope }, {
      status: "indexed", extractionStatus: extraction.state, extractionReceipt: receipt, knowledgeDocumentId: knowledge.document.id,
    });
    return { asset: indexed, extraction, receipt, knowledge, libraryItemId: `library:capture_asset:${asset.id}` };
  });
}

databaseDescribe("Exact Library content pages under serving-role isolation", () => {
  let admin: ReturnType<typeof postgres>;
  let roleCreated = false;
  let small: Fixture;
  let brief: Fixture;
  let oversized: Fixture;

  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    await admin`INSERT INTO omni_auth_tenants (id,name,slug) VALUES (${tenantId},'Content pages',${tenantId})`;
    await admin`INSERT INTO omni_auth_users (id,email,password_hash) VALUES (${userId},${email},'fixture-only')`;
    await admin`INSERT INTO omni_auth_memberships (id,tenant_id,user_id,role) VALUES ('content-page-membership',${tenantId},${userId},'operator')`;

    const smallBytes = await docx(["Aster Vale Field Services. Pilot: 12 of 48 agents. Pilot date: 23 October 2026.", acceptance]);
    const smallDocument = await extractCaptureFile(new File([Buffer.from(smallBytes)], "aster-small.docx"));
    small = await capturedFixture("aster-small.docx", smallBytes, smallDocument.extraction, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

    const paragraphs = ["Aster Vale onboarding: 48 agents, 12-person pilot. Confirmed pilot 23 October, full rollout 30 October conditional on acceptance and written security approval.",
      "Maya owns sandbox 14 October. Jonah owns mapping 15 October. Knowledge owner remains unassigned, due 16 October. Leo owns security 19 October. Sara owns training 21 October.",
      ...Array.from({ length: 22 }, (_, index) => `Operational context ${index + 1}. ${"Each site uses synthetic tickets. Evidence must name its accountable owner and acceptance conditions. ".repeat(7)}`),
      "Mapping acceptance: seven fields request_id, site_code, customer_ref, priority, status, assigned_team, opened_at; 25 valid synthetic tickets; zero invalid site or team values; Priya signoff.", acceptance];
    const briefBytes = await docx(paragraphs);
    const parsedBrief = await extractCaptureFile(new File([Buffer.from(briefBytes)], "aster-onboarding.docx"));
    expect(parsedBrief.extraction.units.length).toBeGreaterThan(8);
    brief = await capturedFixture("aster-onboarding.docx", briefBytes, parsedBrief.extraction, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

    const largeText = "Bounded evidence 🧭 ".repeat(1_180) + "OVERSIZED UNIT TAIL: written client acceptance remains required.";
    const largeExtraction = finalizeCaptureExtraction({ sourceKind: "document", format: "txt",
      units: [{ label: "Long acceptance record", content: largeText, locator: { kind: "text_span" } }] });
    oversized = await capturedFixture("aster-oversized.txt", new TextEncoder().encode(largeText), largeExtraction, "text/plain");

    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE library_content_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    roleCreated = true;
    // Legacy read grants are normally provisioned with the serving login. RLS
    // and canonical evidence integrity guards remain the actual application ones.
    await admin`GRANT SELECT ON omni_schema_version,omni_capture_assets,omni_capture_recordings,omni_knowledge_documents,
      omni_knowledge_chunks,omni_evidence_units,omni_projects,omni_project_artifacts,omni_missions,omni_mission_artifacts,
      omni_source_items,omni_source_revisions,omni_source_sync_heads,omni_oauth_grants TO library_content_runtime`;
    await closeDatabaseClient();
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = "library_content_runtime"; runtimeUrl.password = password;
    vi.stubEnv("DATABASE_URL", runtimeUrl.toString());
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    await ensureDatabaseSchema();
    const [role] = await owned(() => getSql()`SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ name: "library_content_runtime", rolsuper: false, rolbypassrls: false });
  });

  afterAll(async () => {
    await closeDatabaseClient();
    vi.unstubAllEnvs();
    if (admin) {
      if (roleCreated) { await admin`DROP OWNED BY library_content_runtime`; await admin`DROP ROLE library_content_runtime`; }
      await admin.end();
    }
  });

  async function initial(fixture: Fixture) {
    const result = await owned(() => showWorkspaceLibraryItemService(caller, { libraryItemId: fixture.libraryItemId }));
    const item = result.data.item!;
    expect(item.scope.ownerActorId).toBe(actorId);
    return { versionId: item.currentVersion.versionId, contentSha256: item.currentVersion.contentSha256 } satisfies PageRequest;
  }

  async function readPage(fixture: Fixture, request: PageRequest, asContext = context) {
    return owned(() => showWorkspaceLibraryItemService(createAppServiceCaller({ context: asContext }), {
      libraryItemId: fixture.libraryItemId, contentPage: request,
    }), asContext);
  }

  async function readAll(fixture: Fixture) {
    let request: PageRequest | null = await initial(fixture);
    const text = new Map<number, string>();
    const pages = [];
    for (let step = 0; request && step < 80; step += 1) {
      const result = await readPage(fixture, request);
      const page = result.data.contentPage!;
      expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(5_500);
      // Measure real service data and receipt inside the model's execution
      // protocol, including the canonical IDs the provider adapter appends.
      const toolEnvelope = { provenance: "tool_result", trust: "untrusted_data", data: {
        executionId: "00000000-1111-4222-8333-444444444444", status: "executed", dryRun: false,
        approvalRequired: false, note: "Executed for real.", result: { ...result.data, serviceReceipt: result.receipt },
        admissibleEvidenceIds: page.units.map((unit) => unit.citationId),
      } };
      expect(JSON.stringify(toolEnvelope).length).toBeLessThanOrEqual(8_000);
      expect(result.receipt).toMatchObject({ operation: "app.library.show", accessMode: "read" });
      expect(page).toMatchObject({ contentTrust: "untrusted", libraryItemId: fixture.libraryItemId,
        contentSha256: fixture.asset.contentSha256, extractionReceiptSha256: fixture.receipt.receiptSha256 });
      for (const unit of page.units) {
        const previous = text.get(unit.index) || "";
        expect(unit.characterOffset).toBe(previous.length);
        expect(unit.endCharacterOffset).toBe(previous.length + unit.content.length);
        expect(unit.content.isWellFormed()).toBe(true);
        expect(unit.citationId).toBe(`knowledge:${fixture.knowledge.chunks[unit.index].id}`);
        text.set(unit.index, previous + unit.content);
      }
      pages.push(page);
      request = page.next;
    }
    expect(request).toBeNull();
    expect([...text.keys()]).toEqual(fixture.extraction.units.map((unit) => unit.index));
    const completeText = [...text.values()].join("\n\n");
    expect(completeText).toBe(renderCaptureExtractionUnits(fixture.extraction.units));
    return { pages, completeText };
  }

  test("reads the complete small DOCX with a current canonical owner and honest whole-text coverage", async () => {
    const { pages, completeText } = await readAll(small);
    expect(pages).toHaveLength(1);
    expect(pages[0].coverage).toMatchObject({ startsAtBeginning: true, endsAtEnd: true, wholeExtractedText: true });
    expect(completeText).toContain(acceptance);
  });

  test("reaches final acceptance criteria beyond the initial attachment excerpt with no skipped or repeated text", async () => {
    const { pages, completeText } = await readAll(brief);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].coverage).toMatchObject({ startsAtBeginning: true, endsAtEnd: false, wholeExtractedText: false });
    expect(pages.at(-1)!.coverage).toMatchObject({ startsAtBeginning: false, endsAtEnd: true, wholeExtractedText: false });
    expect(completeText).toContain(acceptance);
    expect(completeText.match(/FINAL ACCEPTANCE/g)).toHaveLength(1);
  });

  test("continues within an oversized evidence unit until its final character", async () => {
    const { pages, completeText } = await readAll(oversized);
    expect(pages.length).toBeGreaterThan(4);
    expect(pages[0].next).toMatchObject({ unitIndex: 0, characterOffset: expect.any(Number), extractionReceiptSha256: oversized.receipt.receiptSha256 });
    expect(pages[0].next!.characterOffset).toBeGreaterThan(0);
    expect(completeText).toContain("OVERSIZED UNIT TAIL: written client acceptance remains required.");
  });

  test("rejects wrong pins, unbound continuation, foreign ownership and foreign tenant without returning content", async () => {
    const request = await initial(brief);
    for (const changed of [{ ...request, versionId: "version:wrong" }, { ...request, contentSha256: "f".repeat(64) },
      { ...request, characterOffset: 1 }, { ...request, unitIndex: 1, extractionReceiptSha256: "f".repeat(64) }]) {
      await expect(readPage(brief, changed)).rejects.toThrow();
    }
    for (const outsider of [
      { ...context, actorId: "other@example.test", auth: undefined },
      { ...context, tenantId: "foreign-content-tenant" },
    ]) await expect(readPage(brief, request, outsider)).rejects.toThrow();
    expect(JSON.stringify(await readPage(brief, request))).toContain("Aster Vale");
  });

  test("rechecks the current file digest before reopening a previously valid continuation", async () => {
    const first = await readPage(oversized, await initial(oversized));
    const next = first.data.contentPage!.next!;
    await admin`UPDATE omni_capture_assets SET content_sha256=${"e".repeat(64)} WHERE id=${oversized.asset.id}`;
    try { await expect(readPage(oversized, next)).rejects.toThrow(); }
    finally { await admin`UPDATE omni_capture_assets SET content_sha256=${oversized.asset.contentSha256} WHERE id=${oversized.asset.id}`; }
  });

  test("rejects a same-file reindex between Library metadata and Capture content reads", async () => {
    const request = await initial(brief);
    const read = libraryStore.getWorkspaceLibraryItem;
    // The reader remains real. This barrier changes actual persisted lineage
    // after the first read, reproducing a concurrent indexer's commit.
    const boundary = vi.spyOn(libraryStore, "getWorkspaceLibraryItem").mockImplementationOnce(async (...args) => {
      const item = await read(...args);
      await admin`UPDATE omni_capture_assets SET knowledge_document_id=${small.knowledge.document.id} WHERE id=${brief.asset.id}`;
      return item;
    });
    try { await expect(readPage(brief, request)).rejects.toMatchObject({ code: "library_content_changed" }); }
    finally {
      boundary.mockRestore();
      await admin`UPDATE omni_capture_assets SET knowledge_document_id=${brief.knowledge.document.id} WHERE id=${brief.asset.id}`;
    }
  });

  test("rechecks canonical lineage after verified extraction before exposing citations", async () => {
    const request = await initial(brief);
    const read = captureAssets.getCaptureAssetExtractionForRequest;
    const boundary = vi.spyOn(captureAssets, "getCaptureAssetExtractionForRequest").mockImplementationOnce(async (...args) => {
      const extraction = await read(...args);
      expect(extraction.evidenceAvailable).toBe(true);
      await admin`UPDATE omni_capture_assets SET knowledge_document_id=${small.knowledge.document.id} WHERE id=${brief.asset.id}`;
      return extraction;
    });
    try { await expect(readPage(brief, request)).rejects.toMatchObject({ code: "library_content_changed" }); }
    finally {
      boundary.mockRestore();
      await admin`UPDATE omni_capture_assets SET knowledge_document_id=${brief.knowledge.document.id} WHERE id=${brief.asset.id}`;
    }
  });
});
