import { describe, expect, it } from "vitest";
import {
  MAX_EVIDENCE_UNITS_PER_ADAPTER_OUTPUT,
  SOURCE_CONTRACT_SCHEMA_VERSION,
  buildEvidenceUnitV1,
  buildSourceAdapterDeleteV1,
  buildSourceAdapterUpsertV1,
  buildSourceItemV1,
  buildSourceRevisionV1,
  evidenceLocatorV1Schema,
  parseEvidenceUnitV1,
  parseSourceAdapterOutputV1,
  parseSourceItemV1,
  parseSourceRevisionV1,
  sourceContractSha256,
  type BuildEvidenceUnitV1Input,
  type BuildSourceItemV1Input,
  type BuildSourceRevisionV1Input,
} from "@/lib/sources/contracts";

const SOURCE_CREATED_AT = "2026-01-02T03:04:05.000Z";
const SOURCE_UPDATED_AT = "2026-01-03T03:04:05.000Z";
const CAPTURED_AT = "2026-01-04T03:04:05.000Z";
const EXTRACTED_AT = "2026-01-04T03:05:05.000Z";
const OBSERVED_AT = "2026-01-04T03:06:05.000Z";
const RETENTION_EXPIRES_AT = "2027-01-04T03:04:05.000Z";

function digest(seed: string) {
  return sourceContractSha256({ seed });
}

const binding = {
  tenantId: "tenant_source_test",
  ownerActorId: "actor_source_owner",
  workspaceId: "workspace_source_test",
  projectId: "project_source_test",
  missionId: null,
  connectionId: "connection_drive_test",
  visibility: "project_shared" as const,
  sensitivity: "confidential" as const,
  permissionGrantIds: ["grant_drive_read", "grant_project_member"],
  allowedPurposeIds: ["purpose_context", "purpose_search"],
  retentionPolicyId: "retention_standard",
  retentionExpiresAt: RETENTION_EXPIRES_AT,
};

const extractorIdentity = {
  extractorId: "extractor_plain_text",
  extractorVersionId: "extractor_plain_text_v1",
  extractorConfigSha256: digest("extractor-config"),
  modelVersionId: null,
};

function sourceItemInput(
  overrides: Partial<BuildSourceItemV1Input> = {},
): BuildSourceItemV1Input {
  return {
    ...binding,
    sourceKind: "document",
    providerItemKeySha256: digest("provider-item-key"),
    metadataSha256: digest("source-metadata"),
    sourceCreatedAt: SOURCE_CREATED_AT,
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    capturedAt: CAPTURED_AT,
    extractorIdentity,
    ...overrides,
  };
}

function sourceRevisionInput(
  sourceItemId: string,
  overrides: Partial<BuildSourceRevisionV1Input> = {},
): BuildSourceRevisionV1Input {
  return {
    ...binding,
    sourceItemId,
    previousSourceRevisionId: null,
    sourceKind: "document",
    providerItemKeySha256: digest("provider-item-key"),
    providerRevisionKeySha256: digest("provider-revision-key"),
    contentSha256: digest("source-content"),
    contentByteLength: 1_024,
    mediaType: "text/plain",
    metadataSha256: digest("source-metadata"),
    sourceCreatedAt: SOURCE_CREATED_AT,
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    capturedAt: CAPTURED_AT,
    extractorIdentity,
    ...overrides,
  };
}

function evidenceInput(
  sourceItemId: string,
  sourceRevisionId: string,
  overrides: Partial<BuildEvidenceUnitV1Input> = {},
): BuildEvidenceUnitV1Input {
  return {
    ...binding,
    sourceItemId,
    sourceRevisionId,
    sourceKind: "document",
    providerItemKeySha256: digest("provider-item-key"),
    evidenceContentSha256: digest("bounded-evidence-content"),
    evidenceByteLength: 96,
    locator: {
      kind: "text_span",
      offsetUnit: "utf16_code_unit",
      startOffset: 4,
      endOffsetExclusive: 24,
      containerLength: 80,
      containerSha256: digest("normalized-container"),
    },
    sourceCreatedAt: SOURCE_CREATED_AT,
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    capturedAt: CAPTURED_AT,
    extractedAt: EXTRACTED_AT,
    extractorIdentity,
    ...overrides,
  };
}

function sourceLineage() {
  const sourceItem = buildSourceItemV1(sourceItemInput());
  const sourceRevision = buildSourceRevisionV1(
    sourceRevisionInput(sourceItem.sourceItemId),
  );
  const evidenceUnit = buildEvidenceUnitV1(
    evidenceInput(sourceItem.sourceItemId, sourceRevision.sourceRevisionId),
  );
  return { sourceItem, sourceRevision, evidenceUnit };
}

describe("P2.1 source contracts", () => {
  it("builds deterministic item, immutable revision, evidence, and upsert contracts", () => {
    const first = sourceLineage();
    const repeated = sourceLineage();
    const upsertInput = {
      adapterId: "adapter_drive",
      adapterVersionId: "adapter_drive_v1",
      adapterConfigSha256: digest("adapter-config"),
      adapterEventKeySha256: digest("adapter-event-upsert"),
      observedAt: OBSERVED_AT,
      sourceItem: first.sourceItem,
      sourceRevision: first.sourceRevision,
      evidenceUnits: [first.evidenceUnit],
    };
    const upsert = buildSourceAdapterUpsertV1(upsertInput);

    expect(first).toEqual(repeated);
    expect(first.sourceItem.schemaVersion).toBe(
      SOURCE_CONTRACT_SCHEMA_VERSION,
    );
    expect(first.sourceItem.sourceItemId).toMatch(/^source_item_[a-f0-9]{56}$/);
    expect(first.sourceRevision.sourceRevisionId).toMatch(
      /^source_revision_[a-f0-9]{56}$/,
    );
    expect(first.evidenceUnit.evidenceUnitId).toMatch(
      /^evidence_unit_[a-f0-9]{56}$/,
    );
    expect(first.evidenceUnit.locator.kind).toBe("text_span");
    expect(upsert.operation).toBe("upsert");
    expect(buildSourceAdapterUpsertV1(upsertInput)).toEqual(upsert);
    expect(parseSourceItemV1(first.sourceItem)).toEqual(first.sourceItem);
    expect(parseSourceRevisionV1(first.sourceRevision)).toEqual(
      first.sourceRevision,
    );
    expect(parseEvidenceUnitV1(first.evidenceUnit)).toEqual(first.evidenceUnit);
    expect(parseSourceAdapterOutputV1(upsert)).toEqual(upsert);
    expect(MAX_EVIDENCE_UNITS_PER_ADAPTER_OUTPUT).toBeGreaterThanOrEqual(1_024);
  });

  it("changes immutable revision identity when any revision field changes", () => {
    const sourceItem = buildSourceItemV1(sourceItemInput());
    const original = buildSourceRevisionV1(
      sourceRevisionInput(sourceItem.sourceItemId),
    );
    const changed = buildSourceRevisionV1(
      sourceRevisionInput(sourceItem.sourceItemId, {
        contentByteLength: original.contentByteLength + 1,
      }),
    );

    expect(changed.sourceRevisionId).not.toBe(original.sourceRevisionId);
  });

  it("keeps raw source content, arbitrary metadata, and raw provider IDs outside contracts", () => {
    const input = {
      ...sourceItemInput(),
      content: "private source content",
      externalItemId: "provider/raw/item/123",
      metadata: { title: "private title" },
    } as BuildSourceItemV1Input;

    expect(() => buildSourceItemV1(input)).toThrow();

    const { sourceItem } = sourceLineage();
    expect(() => parseSourceItemV1({
      ...sourceItem,
      rawContent: "private source content",
    })).toThrow();
    expect(JSON.stringify(sourceItem)).not.toContain("provider/raw/item/123");
    expect(JSON.stringify(sourceItem)).not.toContain("private source content");
  });

  it("validates exact canonical locator variants and their bounds", () => {
    const locators = [
      {
        kind: "page",
        pageNumber: 2,
        pageCount: 10,
      },
      {
        kind: "sheet_range",
        sheetKeySha256: digest("sheet-key"),
        startRow: 2,
        endRowExclusive: 5,
        startColumn: 1,
        endColumnExclusive: 3,
        sheetRowCount: 100,
        sheetColumnCount: 20,
      },
      {
        kind: "slide",
        slideNumber: 3,
        slideCount: 12,
        elementKeySha256: digest("slide-element"),
      },
      {
        kind: "email_section",
        section: "body",
        sectionIndex: 0,
        partKeySha256: digest("email-part"),
      },
      {
        kind: "image_region",
        coordinateUnit: "pixel",
        x: 20,
        y: 10,
        width: 100,
        height: 50,
        imageWidth: 640,
        imageHeight: 480,
      },
      {
        kind: "media_time_range",
        mediaKind: "audio",
        startMilliseconds: 1_000,
        endMillisecondsExclusive: 5_000,
        durationMilliseconds: 10_000,
      },
    ] as const;

    locators.forEach((locator) => {
      expect(evidenceLocatorV1Schema.parse(locator)).toEqual(locator);
    });

    expect(() => evidenceLocatorV1Schema.parse({
      kind: "text_span",
      offsetUnit: "utf16_code_unit",
      startOffset: 20,
      endOffsetExclusive: 81,
      containerLength: 80,
      containerSha256: digest("container"),
    })).toThrow(/container length/i);
    expect(() => evidenceLocatorV1Schema.parse({
      kind: "image_region",
      coordinateUnit: "pixel",
      x: 620,
      y: 0,
      width: 40,
      height: 10,
      imageWidth: 640,
      imageHeight: 480,
    })).toThrow(/image width/i);
  });

  it("rejects cross-tenant, cross-owner, and cross-connection upsert lineage", () => {
    const { sourceItem, evidenceUnit } = sourceLineage();
    const mismatchedRevision = buildSourceRevisionV1(
      sourceRevisionInput(sourceItem.sourceItemId, {
        connectionId: "connection_other",
      }),
    );

    expect(() => buildSourceAdapterUpsertV1({
      adapterId: "adapter_drive",
      adapterVersionId: "adapter_drive_v1",
      adapterConfigSha256: digest("adapter-config"),
      adapterEventKeySha256: digest("adapter-event-mismatch"),
      observedAt: OBSERVED_AT,
      sourceItem,
      sourceRevision: mismatchedRevision,
      evidenceUnits: [evidenceUnit],
    })).toThrow(/scope or connection/i);
  });

  it("allows derived policy narrowing but rejects permission or retention broadening", () => {
    const sourceItem = buildSourceItemV1(sourceItemInput());
    const narrowedRevision = buildSourceRevisionV1(
      sourceRevisionInput(sourceItem.sourceItemId, {
        permissionGrantIds: ["grant_drive_read"],
        allowedPurposeIds: ["purpose_search"],
        retentionExpiresAt: "2026-12-01T00:00:00.000Z",
      }),
    );
    const narrowedEvidence = buildEvidenceUnitV1(
      evidenceInput(sourceItem.sourceItemId, narrowedRevision.sourceRevisionId, {
        permissionGrantIds: ["grant_drive_read"],
        allowedPurposeIds: ["purpose_search"],
        retentionExpiresAt: "2026-12-01T00:00:00.000Z",
      }),
    );

    expect(() => buildSourceAdapterUpsertV1({
      adapterId: "adapter_drive",
      adapterVersionId: "adapter_drive_v1",
      adapterConfigSha256: digest("adapter-config"),
      adapterEventKeySha256: digest("adapter-event-narrowed"),
      observedAt: OBSERVED_AT,
      sourceItem,
      sourceRevision: narrowedRevision,
      evidenceUnits: [narrowedEvidence],
    })).not.toThrow();

    const broadenedRevision = buildSourceRevisionV1(
      sourceRevisionInput(sourceItem.sourceItemId, {
        permissionGrantIds: [
          "grant_drive_read",
          "grant_external_share",
          "grant_project_member",
        ],
      }),
    );
    expect(() => buildSourceAdapterUpsertV1({
      adapterId: "adapter_drive",
      adapterVersionId: "adapter_drive_v1",
      adapterConfigSha256: digest("adapter-config"),
      adapterEventKeySha256: digest("adapter-event-broadened"),
      observedAt: OBSERVED_AT,
      sourceItem,
      sourceRevision: broadenedRevision,
      evidenceUnits: [],
    })).toThrow(/broaden permission/i);
  });

  it("builds a deterministic metadata-only delete branch", () => {
    const { sourceItem, sourceRevision } = sourceLineage();
    const input = {
      adapterId: "adapter_drive",
      adapterVersionId: "adapter_drive_v1",
      adapterConfigSha256: digest("adapter-config"),
      adapterEventKeySha256: digest("adapter-event-delete"),
      observedAt: OBSERVED_AT,
      ...binding,
      sourceItemId: sourceItem.sourceItemId,
      sourceKind: sourceItem.sourceKind,
      providerItemKeySha256: sourceItem.providerItemKeySha256,
      lastKnownSourceRevisionId: sourceRevision.sourceRevisionId,
      deleteReason: "provider_deleted" as const,
    };
    const deletion = buildSourceAdapterDeleteV1(input);

    expect(deletion.operation).toBe("delete");
    expect(buildSourceAdapterDeleteV1(input)).toEqual(deletion);
    expect(parseSourceAdapterOutputV1(deletion)).toEqual(deletion);
    expect("sourceRevision" in deletion).toBe(false);
    expect("evidenceUnits" in deletion).toBe(false);
    expect(() => parseSourceAdapterOutputV1({
      ...deletion,
      content: "deleted private content",
    })).toThrow();
  });

  it("fails closed when a contract body or derived digest is altered", () => {
    const { sourceRevision, evidenceUnit } = sourceLineage();

    expect(() => parseSourceRevisionV1({
      ...sourceRevision,
      contentByteLength: sourceRevision.contentByteLength + 1,
    })).toThrow(/digest/i);
    expect(() => parseEvidenceUnitV1({
      ...evidenceUnit,
      locatorSha256: digest("wrong-locator"),
    })).toThrow(/locator digest/i);
  });

  it("rejects a self-consistent adapter envelope with a divergent item policy", () => {
    const { sourceItem, sourceRevision, evidenceUnit } = sourceLineage();
    const upsert = buildSourceAdapterUpsertV1({
      adapterId: "adapter_drive",
      adapterVersionId: "adapter_drive_v1",
      adapterConfigSha256: digest("adapter-config"),
      adapterEventKeySha256: digest("adapter-event-policy-mismatch"),
      observedAt: OBSERVED_AT,
      sourceItem,
      sourceRevision,
      evidenceUnits: [evidenceUnit],
    });
    const tampered = {
      ...upsert,
      retentionPolicyId: "retention_other",
    };
    const { adapterOutputSha256: _oldDigest, ...tamperedBody } = tampered;

    expect(() => parseSourceAdapterOutputV1({
      ...tamperedBody,
      adapterOutputSha256: sourceContractSha256(tamperedBody),
    })).toThrow(/binding/i);
  });
});
