import { describe, expect, it } from "vitest";

import {
  buildDataInfluenceManifestV1,
  dataInfluenceManifestV1Schema,
} from "@/lib/security/data-influence";

describe("DataInfluenceManifestV1", () => {
  it("separates externally validated authority references from untrusted data", () => {
    const manifest = buildDataInfluenceManifestV1({
      tenantId: "tenant-one",
      runId: "run-one",
      executionId: "execution-one",
      principalId: "agent:asael",
      createdAt: "2026-09-22T09:00:00.000Z",
      authorityReferences: [
        {
          kind: "standing_grant",
          referenceId: "grant-one",
          evidenceSha256: "b".repeat(64),
        },
        {
          kind: "authenticated_intent",
          referenceId: "intent-one",
          evidenceSha256: "a".repeat(64),
        },
      ],
      untrustedInfluences: [
        {
          kind: "web",
          referenceId: "evidence-one",
          contentSha256: "d".repeat(64),
        },
        {
          kind: "memory",
          referenceId: "memory-one",
          contentSha256: "c".repeat(64),
        },
      ],
    });

    expect(manifest.authorityReferences.map((entry) => entry.kind)).toEqual([
      "authenticated_intent",
      "standing_grant",
    ]);
    expect(manifest.untrustedInfluences.map((entry) => entry.kind)).toEqual([
      "memory",
      "web",
    ]);
    expect(manifest.authorityInvariant).toEqual({
      manifestGrantsAuthority: false,
      untrustedDataGrantsAuthority: false,
      authorizationRequiresExternalValidation: true,
    });
  });

  it("binds the complete manifest and refuses authority laundering", () => {
    const manifest = buildDataInfluenceManifestV1({
      tenantId: "tenant-one",
      runId: "run-one",
      executionId: "execution-one",
      principalId: "agent:asael",
      createdAt: "2026-09-22T09:00:00.000Z",
      authorityReferences: [],
      untrustedInfluences: [{
        kind: "model",
        referenceId: "model-output-one",
        contentSha256: "e".repeat(64),
      }],
    });

    expect(dataInfluenceManifestV1Schema.safeParse({
      ...manifest,
      principalId: "agent:other",
    }).success).toBe(false);
    expect(dataInfluenceManifestV1Schema.safeParse({
      ...manifest,
      authorityInvariant: {
        ...manifest.authorityInvariant,
        untrustedDataGrantsAuthority: true,
      },
    }).success).toBe(false);
    expect(dataInfluenceManifestV1Schema.safeParse({
      ...manifest,
      authorityReferences: [{
        kind: "web",
        referenceId: "evidence-one",
        evidenceSha256: "e".repeat(64),
      }],
    }).success).toBe(false);
  });

  it("produces one digest independent of caller entry order", () => {
    const input = {
      tenantId: "tenant-one",
      runId: "run-one",
      executionId: "execution-one",
      principalId: "agent:asael",
      createdAt: "2026-09-22T09:00:00.000Z",
      authorityReferences: [
        {
          kind: "explicit_approval" as const,
          referenceId: "approval-two",
          evidenceSha256: "2".repeat(64),
        },
        {
          kind: "explicit_approval" as const,
          referenceId: "approval-one",
          evidenceSha256: "1".repeat(64),
        },
      ],
      untrustedInfluences: [],
    };
    const forward = buildDataInfluenceManifestV1(input);
    const reverse = buildDataInfluenceManifestV1({
      ...input,
      authorityReferences: [...input.authorityReferences].reverse(),
    });

    expect(forward.manifestSha256).toBe(reverse.manifestSha256);
  });
});
