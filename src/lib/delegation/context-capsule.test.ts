import { describe, expect, it } from "vitest";

import {
  buildDelegationContextCapsuleV1,
  parseDelegationContextCapsuleV1,
} from "@/lib/delegation/context-capsule";

describe("delegation context capsule", () => {
  it("defaults to a bounded reference-only isolated context without a transcript", () => {
    const capsule = buildCapsule();

    expect(capsule).toMatchObject({
      version: "delegation-context-capsule:1",
      mode: "isolated",
      parentTranscript: {
        included: false,
        manifestId: null,
        manifestSha256: null,
        turns: [],
      },
      dataBoundary: {
        contentByReferenceOnly: true,
        credentialMaterialIncluded: false,
        messagesGrantAuthority: false,
        retrievedDataGrantsAuthority: false,
        authoritySource: "delegation_execution_contract_only",
      },
    });
    expect(capsule.capsuleId).toBe(`delegation-context:${capsule.capsuleSha256}`);
    expect(capsule.selection.contextRefs[0]?.contentSha256).toBe("a".repeat(64));
    expect(Object.isFrozen(capsule)).toBe(true);
    expect(Object.isFrozen(capsule.selection.contextRefs)).toBe(true);
  });

  it("permits an exact parent transcript manifest only for fork mode", () => {
    const fork = buildDelegationContextCapsuleV1({
      mode: "fork",
      scope,
      parentTranscript: {
        manifestId: "transcript-manifest:one",
        turns: [{
          sequence: 0,
          turnId: "turn:one",
          role: "user",
          contentSha256: "d".repeat(64),
          selectedByteCount: 42,
        }],
      },
    });

    expect(fork.parentTranscript).toMatchObject({
      included: true,
      manifestId: "transcript-manifest:one",
    });
    expect(fork.parentTranscript.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => buildDelegationContextCapsuleV1({
      mode: "team",
      scope,
      parentTranscript: {
        manifestId: "transcript-manifest:one",
        turns: [{
          sequence: 0,
          turnId: "turn:one",
          role: "user",
          contentSha256: "d".repeat(64),
          selectedByteCount: 42,
        }],
      },
    })).toThrow(/Only fork delegation/);
  });

  it("rejects transcript, selection, capsule, credential, and byte-boundary tampering", () => {
    const fork = buildDelegationContextCapsuleV1({
      mode: "fork",
      scope,
      parentTranscript: {
        manifestId: "transcript-manifest:one",
        turns: [{
          sequence: 0,
          turnId: "turn:one",
          role: "user",
          contentSha256: "d".repeat(64),
          selectedByteCount: 42,
        }],
      },
    });
    expect(() => parseDelegationContextCapsuleV1({
      ...fork,
      parentTranscript: {
        ...fork.parentTranscript,
        turns: [{
          ...fork.parentTranscript.turns[0],
          contentSha256: "e".repeat(64),
        }],
      },
    })).toThrow(/manifest digest|integrity/i);

    expect(() => parseDelegationContextCapsuleV1({
      ...buildCapsule(),
      selectionSha256: "f".repeat(64),
    })).toThrow(/selection digest|integrity/i);

    expect(() => buildDelegationContextCapsuleV1({
      mode: "isolated",
      scope,
      contextRefs: [{
        contextRefId: "context:secret",
        sourceKind: "document",
        sourceId: "password:verysecretvalue",
        revisionId: null,
        contentSha256: "a".repeat(64),
        contextGrantId: "grant:context:one",
        trust: "trusted_first_party",
        selectedByteCount: 1,
      }],
    })).toThrow(/credential material/i);

    expect(() => buildDelegationContextCapsuleV1({
      mode: "fork",
      scope,
      contextRefs: Array.from({ length: 4 }, (_, index) => ({
        contextRefId: `context:large:${index}`,
        sourceKind: "document" as const,
        sourceId: `document:${index}`,
        revisionId: null,
        contentSha256: "a".repeat(64),
        contextGrantId: "grant:context:one",
        trust: "trusted_first_party" as const,
        selectedByteCount: 512_000,
      })),
      parentTranscript: {
        manifestId: "transcript-manifest:large",
        turns: [{
          sequence: 0,
          turnId: "turn:large",
          role: "user",
          contentSha256: "d".repeat(64),
          selectedByteCount: 1,
        }],
      },
    })).toThrow(/byte budget/i);
  });
});

const scope = {
  tenantId: "tenant-one",
  initiatingActorId: "actor-one",
  rootExecutionId: "run-root",
  rootPrincipalId: "principal:root",
  parentExecutionId: "run-root",
  parentPrincipalId: "principal:root",
  delegationId: "delegation:one",
};

function buildCapsule() {
  return buildDelegationContextCapsuleV1({
    mode: "isolated",
    scope,
    contextRefs: [{
      contextRefId: "context:one",
      sourceKind: "memory",
      sourceId: "memory:one",
      revisionId: "memory:one:v3",
      contentSha256: "a".repeat(64),
      contextGrantId: "grant:context:one",
      trust: "trusted_first_party",
      selectedByteCount: 120,
    }],
    evidenceRefs: [{
      evidenceRefId: "evidence-ref:one",
      evidenceId: "evidence:one",
      sourceId: "source:one",
      snapshotSha256: "b".repeat(64),
      authorizationDecisionSha256: "c".repeat(64),
      contextGrantId: "grant:context:one",
      trust: "untrusted_retrieved",
      selectedByteCount: 240,
    }],
    artifactRefs: [{
      artifactRefId: "artifact-ref:one",
      artifactId: "artifact:one",
      artifactVersionId: "artifact:one:v2",
      contentSha256: "d".repeat(64),
      mediaType: "text/plain",
      contextGrantId: "grant:context:one",
      selectedByteCount: 360,
    }],
  });
}
