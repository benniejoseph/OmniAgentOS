import { describe, expect, it } from "vitest";
import {
  buildPortableArchiveV2,
  createPortableAssetEncryption,
  decryptPortableAssetBytes,
  encryptPortableAssetBytes,
  portableBytesSha256,
  portableTextSha256,
  verifyPortableArchiveV2,
  type PortableArchiveDataV2,
} from "@/lib/data/portable-contract";

function emptyData(): PortableArchiveDataV2 {
  return {
    knowledge: [],
    memories: [],
    threads: [],
    today: [],
    projects: [],
    connections: [],
    skills: [],
    agents: [],
    assets: [],
  };
}

describe("portable archive v2 contract", () => {
  it("binds every declared section, count, exclusion, and archive digest", () => {
    const data = emptyData();
    data.knowledge.push({
      sourceId: "knowledge-a",
      title: "Portable knowledge",
      content: "Verified archive content",
      contentSha256: portableTextSha256("Verified archive content"),
      source: "manual",
      sourceType: "manual",
      tags: ["portable"],
      sourceContentSha256: null,
      sourceRevisionIdSha256: null,
      updatedAt: "2026-09-06T10:00:00.000Z",
    });
    data.memories.push({
      sourceId: "memory-a",
      title: "Tiered memory",
      content: "Remember the verified decision.",
      contentSha256: portableTextSha256("Remember the verified decision."),
      type: "decision",
      tier: "decision",
      tierPolicyVersion: 1,
      formationReason: "explicit_user_request",
      tags: ["portable"],
      scope: "user",
      source: "user-assertion",
      importance: 0.9,
      confidence: 1,
      claimStatus: "active",
      assertedBy: "user",
      evidenceRefs: ["thread:a", "turn:b"],
      validFrom: null,
      validTo: null,
      retentionExpiresAt: null,
      lastUsedAt: "2026-09-06T10:01:00.000Z",
      useCount: 2,
      promotedFromTier: null,
      promotedAt: null,
      supersedesId: null,
      contradictionOfId: null,
      createdAt: "2026-09-06T10:00:00.000Z",
      updatedAt: "2026-09-06T10:01:00.000Z",
    });
    const archive = buildPortableArchiveV2({
      exportedAt: "2026-09-06T10:05:00.000Z",
      sourceOwnerActorId: "owner-a",
      sourceTenantId: "tenant-a",
      data,
      exclusions: [{ category: "secrets", reason: "always_excluded", count: null }],
    });

    expect(verifyPortableArchiveV2(archive)).toEqual(archive);
    expect(archive.manifest.sections.knowledge.includedCount).toBe(1);
    expect(archive.manifest.sections.memories.includedCount).toBe(1);
    expect(archive.manifest.totals.includedCount).toBe(2);
    expect(archive.manifest.secretsExcluded).toBe(true);

    const tampered = structuredClone(archive);
    tampered.data.knowledge[0]!.content = "tampered";
    expect(() => verifyPortableArchiveV2(tampered)).toThrow(/failed manifest or content verification/i);

    const duplicated = structuredClone(archive);
    duplicated.data.knowledge.push(duplicated.data.knowledge[0]!);
    expect(() => buildPortableArchiveV2({
      exportedAt: duplicated.exportedAt,
      sourceOwnerActorId: "owner-a",
      sourceTenantId: "tenant-a",
      data: duplicated.data,
    })).toThrow(/sourceId values must be unique/i);
  });

  it("encrypts assets with metadata-bound authenticated encryption", () => {
    const bytes = Buffer.from("private original bytes");
    const encryption = createPortableAssetEncryption();
    const asset = encryptPortableAssetBytes({
      metadata: {
        sourceIdSha256: portableTextSha256("asset-a"),
        filename: "private.txt",
        mediaType: "text/plain",
        extension: "txt",
        byteCount: bytes.byteLength,
        contentSha256: portableBytesSha256(bytes),
        tags: ["private"],
        createdAt: "2026-09-06T10:00:00.000Z",
      },
      bytes,
      passphrase: "correct horse battery staple",
      encryption,
    });

    expect(decryptPortableAssetBytes({
      asset,
      passphrase: "correct horse battery staple",
      encryption,
    })).toEqual(bytes);
    expect(() => decryptPortableAssetBytes({
      asset,
      passphrase: "incorrect passphrase value",
      encryption,
    })).toThrow(/could not be opened or verified/i);
  });
});
