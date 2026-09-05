import { describe, expect, it } from "vitest";
import {
  MEMORY_INFORMED_NOTICE_RECEIPT_EVENT_TYPE,
  MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES,
  MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES,
  MEMORY_PURPOSE_CONSENT_EVENT_TYPES,
  MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES,
  assertMemoryMembershipManagementAuthorityRecordEventBindingV1,
  assertMemoryConsentReceiptStructuralBindingV1,
  buildMemoryMembershipManagementAuthorityEventV1,
  buildMemoryInformedNoticeReceiptEventV1,
  buildMemoryMembershipEpochEventV1,
  buildMemoryPurposeConsentEventV1,
  buildMemoryPurposeEntitlementEventV1,
  memoryAuthorityEventTypeSchema,
  parseMemoryAuthorityEventV1,
  parseMemoryMembershipManagementAuthorityEventV1,
  parseMemoryMembershipManagementAuthorityEventPayloadV1,
  parseMemoryMembershipManagementAuthorityRecordV1,
  parseMemoryInformedNoticeReceiptEventV1,
  parseMemoryMembershipEpochEventV1,
  parseMemoryPurposeConsentEventV1,
  parseMemoryPurposeEntitlementEventV1,
  type BuildMemoryInformedNoticeReceiptEventV1Input,
  type BuildMemoryMembershipManagementAuthorityEventV1Input,
  type BuildMemoryMembershipEpochEventV1Input,
  type BuildMemoryPurposeConsentEventV1Input,
  type BuildMemoryPurposeEntitlementEventV1Input,
} from "@/lib/memory/authority-contracts";

const TENANT_ID = "tenant:authority-contract-test";
const OTHER_TENANT_ID = "tenant:authority-contract-other";
const SUBJECT_ACTOR_ID =
  "actor:11111111-1111-4111-8111-111111111111";
const DECISION_ACTOR_ID =
  "actor:22222222-2222-4222-8222-222222222222";
const OTHER_ACTOR_ID =
  "actor:33333333-3333-4333-8333-333333333333";
const PURPOSE_ID = "memory.read.v1";
const NOTICE_RECEIPT_ID = "notice-receipt:authority-contract-test";
const NOTICE_CONTRACT_ID = "notice-contract:memory-read";
const DECISION_AT = "2026-09-05T09:30:00.000Z";
const PRESENTED_AT = "2026-09-05T09:29:58.000Z";
const ACKNOWLEDGED_AT = "2026-09-05T09:30:00.000Z";
const NOTICE_SHA256 = "a".repeat(64);
const MANAGEMENT_AUTHORITY_ID = "membership-authority:contract-test";
const GOVERNANCE_DECISION_ID = "governance@decision:contract-test";
const AUTHORITY_CREATED_AT = "2026-09-05T09:30:00.000Z";
const AUTHORITY_ACTIVATED_AT = "2026-09-05T09:30:01.000Z";
const AUTHORITY_REVOKED_AT = "2026-09-05T09:30:02.000Z";

function managementAuthorityRecordBase() {
  return {
    schemaVersion: 1,
    tenantId: TENANT_ID,
    subjectActorId: SUBJECT_ACTOR_ID,
    granteeActorId: DECISION_ACTOR_ID,
    managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
    authorityGeneration: 2,
    createdByActorId: OTHER_ACTOR_ID,
    createdAt: AUTHORITY_CREATED_AT,
  } as const;
}

function heldManagementAuthorityRecord() {
  return {
    ...managementAuthorityRecordBase(),
    state: "held",
    lifecycleRevision: 0,
    activatedByActorId: null,
    revokedByActorId: null,
    activatedAt: null,
    revokedAt: null,
    updatedAt: AUTHORITY_CREATED_AT,
  } as const;
}

function activeManagementAuthorityRecord() {
  return {
    ...managementAuthorityRecordBase(),
    state: "active",
    lifecycleRevision: 1,
    activatedByActorId: OTHER_ACTOR_ID,
    revokedByActorId: null,
    activatedAt: AUTHORITY_ACTIVATED_AT,
    revokedAt: null,
    updatedAt: AUTHORITY_ACTIVATED_AT,
  } as const;
}

function heldRevokedManagementAuthorityRecord() {
  return {
    ...managementAuthorityRecordBase(),
    state: "revoked",
    lifecycleRevision: 1,
    activatedByActorId: null,
    revokedByActorId: OTHER_ACTOR_ID,
    activatedAt: null,
    revokedAt: AUTHORITY_REVOKED_AT,
    updatedAt: AUTHORITY_REVOKED_AT,
  } as const;
}

function activeRevokedManagementAuthorityRecord() {
  return {
    ...managementAuthorityRecordBase(),
    state: "revoked",
    lifecycleRevision: 2,
    activatedByActorId: OTHER_ACTOR_ID,
    revokedByActorId: OTHER_ACTOR_ID,
    activatedAt: AUTHORITY_ACTIVATED_AT,
    revokedAt: AUTHORITY_REVOKED_AT,
    updatedAt: AUTHORITY_REVOKED_AT,
  } as const;
}

function membershipBase() {
  return {
    tenantId: TENANT_ID,
    subjectActorId: SUBJECT_ACTOR_ID,
    membershipEpoch: 3,
    decisionActorId: DECISION_ACTOR_ID,
    membershipManagementAuthorityId: "authority:membership.manage.v1",
    decisionAt: DECISION_AT,
  } as const;
}

function entitlementBase() {
  return {
    tenantId: TENANT_ID,
    purposeId: PURPOSE_ID,
    entitlementGeneration: 4,
    decisionActorId: DECISION_ACTOR_ID,
    decisionMembershipEpoch: 3,
    entitlementManagementAuthorityId: "authority:entitlement.manage.v1",
    decisionAt: DECISION_AT,
  } as const;
}

function receiptInput(): BuildMemoryInformedNoticeReceiptEventV1Input {
  return {
    tenantId: TENANT_ID,
    subjectActorId: SUBJECT_ACTOR_ID,
    purposeId: PURPOSE_ID,
    consentGeneration: 5,
    membershipEpoch: 3,
    noticeReceiptId: NOTICE_RECEIPT_ID,
    noticeContractId: NOTICE_CONTRACT_ID,
    noticeContractVersion: 2,
    noticeSha256: NOTICE_SHA256,
    presentedAt: PRESENTED_AT,
    acknowledgedByActorId: SUBJECT_ACTOR_ID,
    acknowledgedAt: ACKNOWLEDGED_AT,
  };
}

function consentBase() {
  return {
    tenantId: TENANT_ID,
    subjectActorId: SUBJECT_ACTOR_ID,
    purposeId: PURPOSE_ID,
    consentGeneration: 5,
    membershipEpoch: 3,
    noticeReceiptId: NOTICE_RECEIPT_ID,
    decisionAt: DECISION_AT,
  } as const;
}

describe("membership management authority contracts", () => {
  it("models every reserved v56 record and event lifecycle shape", () => {
    const variants = [
      {
        record: heldManagementAuthorityRecord(),
        decisionAt: AUTHORITY_CREATED_AT,
        type: MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.held,
      },
      {
        record: activeManagementAuthorityRecord(),
        decisionAt: AUTHORITY_ACTIVATED_AT,
        type: MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.active,
      },
      {
        record: heldRevokedManagementAuthorityRecord(),
        decisionAt: AUTHORITY_REVOKED_AT,
        type: MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.revoked,
      },
      {
        record: activeRevokedManagementAuthorityRecord(),
        decisionAt: AUTHORITY_REVOKED_AT,
        type: MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.revoked,
      },
    ] as const;

    for (const variant of variants) {
      const record = parseMemoryMembershipManagementAuthorityRecordV1(
        variant.record,
      );
      const input = {
        tenantId: record.tenantId,
        subjectActorId: record.subjectActorId,
        granteeActorId: record.granteeActorId,
        managementAuthorityId: record.managementAuthorityId,
        authorityGeneration: record.authorityGeneration,
        governanceDecisionId: GOVERNANCE_DECISION_ID,
        decisionActorId: OTHER_ACTOR_ID,
        decisionAt: variant.decisionAt,
        state: record.state,
        lifecycleRevision: record.lifecycleRevision,
      } as BuildMemoryMembershipManagementAuthorityEventV1Input;
      const event = buildMemoryMembershipManagementAuthorityEventV1(input);
      const parsedPayload =
        parseMemoryMembershipManagementAuthorityEventPayloadV1({
          ...event.payload,
        });
      const parsedEvent = parseMemoryAuthorityEventV1({
        type: event.type,
        payload: { ...event.payload },
      });
      const binding =
        assertMemoryMembershipManagementAuthorityRecordEventBindingV1(
          record,
          event,
        );

      expect(event.type).toBe(variant.type);
      expect(event.payload).toMatchObject({
        schemaVersion: 1,
        recordSchemaVersion: 1,
        payloadKind: "memory_membership_management_authority",
        governanceDecisionId: GOVERNANCE_DECISION_ID,
        state: record.state,
        lifecycleRevision: record.lifecycleRevision,
      });
      expect(event.payload.decisionActorId).not.toBe(record.subjectActorId);
      expect(event.payload.decisionActorId).not.toBe(record.granteeActorId);
      expect(parsedPayload).toEqual(event.payload);
      expect(parsedEvent).toEqual(event);
      expect(binding).toMatchObject({
        tenantId: TENANT_ID,
        subjectActorId: SUBJECT_ACTOR_ID,
        granteeActorId: DECISION_ACTOR_ID,
        managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
        authorityGeneration: 2,
      });
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.payload)).toBe(true);
      expect(Object.isFrozen(parsedPayload)).toBe(true);
      expect(Object.isFrozen(parsedEvent)).toBe(true);
      expect(Object.isFrozen(parsedEvent.payload)).toBe(true);
      expect(Object.isFrozen(binding)).toBe(true);
      expect(record).not.toBe(variant.record);
      expect(event.payload).not.toBe(input);
      expect(parsedPayload).not.toBe(event.payload);
      expect(parsedEvent).not.toBe(event);
      expect(parsedEvent.payload).not.toBe(event.payload);
    }

    expect(
      Object.isFrozen(MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES),
    ).toBe(true);
  });

  it("rejects unreachable state, revision, attribution, and timestamp matrices", () => {
    const invalidRecords = [
      { ...heldManagementAuthorityRecord(), lifecycleRevision: 1 },
      { ...activeManagementAuthorityRecord(), lifecycleRevision: 2 },
      {
        ...activeManagementAuthorityRecord(),
        activatedByActorId: null,
      },
      {
        ...heldRevokedManagementAuthorityRecord(),
        activatedByActorId: OTHER_ACTOR_ID,
        activatedAt: AUTHORITY_ACTIVATED_AT,
      },
      {
        ...activeRevokedManagementAuthorityRecord(),
        activatedByActorId: null,
        activatedAt: null,
      },
      {
        ...activeManagementAuthorityRecord(),
        updatedAt: AUTHORITY_REVOKED_AT,
      },
      {
        ...activeRevokedManagementAuthorityRecord(),
        activatedAt: "2026-09-05T09:30:03.000Z",
      },
      {
        ...heldManagementAuthorityRecord(),
        createdAt: "2026-09-05T09:30:03.000Z",
      },
      {
        ...heldManagementAuthorityRecord(),
        createdAt: "2026-09-05T09:30:00Z",
        updatedAt: "2026-09-05T09:30:00Z",
      },
    ];

    for (const record of invalidRecords) {
      expect(() =>
        parseMemoryMembershipManagementAuthorityRecordV1(record)
      ).toThrow();
    }

    expect(() => buildMemoryMembershipManagementAuthorityEventV1({
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ACTOR_ID,
      granteeActorId: DECISION_ACTOR_ID,
      managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
      authorityGeneration: 2,
      governanceDecisionId: GOVERNANCE_DECISION_ID,
      decisionActorId: OTHER_ACTOR_ID,
      decisionAt: AUTHORITY_ACTIVATED_AT,
      state: "active",
      lifecycleRevision: 2,
    } as unknown as BuildMemoryMembershipManagementAuthorityEventV1Input))
      .toThrow();
    expect(() => buildMemoryMembershipManagementAuthorityEventV1({
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ACTOR_ID,
      granteeActorId: DECISION_ACTOR_ID,
      managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
      authorityGeneration: 2,
      governanceDecisionId: GOVERNANCE_DECISION_ID,
      decisionActorId: OTHER_ACTOR_ID,
      decisionAt: AUTHORITY_REVOKED_AT,
      state: "revoked",
      lifecycleRevision: 0,
    } as unknown as BuildMemoryMembershipManagementAuthorityEventV1Input))
      .toThrow();
  });

  it("rejects noncanonical coordinates and non-positive-safe generations", () => {
    const held = heldManagementAuthorityRecord();
    for (const authorityGeneration of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "2",
    ]) {
      expect(() => parseMemoryMembershipManagementAuthorityRecordV1({
        ...held,
        authorityGeneration,
      })).toThrow();
    }

    const invalidCoordinates = [
      ["tenantId", ` ${TENANT_ID}`],
      ["subjectActorId", "person@example.test"],
      ["granteeActorId", DECISION_ACTOR_ID.toUpperCase()],
      ["createdByActorId", ` ${OTHER_ACTOR_ID}`],
      ["managementAuthorityId", `${MANAGEMENT_AUTHORITY_ID} `],
    ] as const;
    for (const [field, value] of invalidCoordinates) {
      expect(() => parseMemoryMembershipManagementAuthorityRecordV1({
        ...held,
        [field]: value,
      })).toThrow();
    }

    expect(() => parseMemoryMembershipManagementAuthorityRecordV1({
      ...held,
      schemaVersion: 2,
    })).toThrow();

    const {
      managementAuthorityId: _managementAuthorityId,
      ...withoutManagementAuthorityId
    } = held;
    void _managementAuthorityId;
    expect(() => parseMemoryMembershipManagementAuthorityRecordV1(
      withoutManagementAuthorityId,
    )).toThrow();

    expect(() => buildMemoryMembershipManagementAuthorityEventV1({
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ACTOR_ID,
      granteeActorId: DECISION_ACTOR_ID,
      managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
      authorityGeneration: 2,
      governanceDecisionId: ` ${GOVERNANCE_DECISION_ID}`,
      decisionActorId: OTHER_ACTOR_ID,
      decisionAt: AUTHORITY_CREATED_AT,
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
    expect(() => buildMemoryMembershipManagementAuthorityEventV1({
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ACTOR_ID,
      granteeActorId: DECISION_ACTOR_ID,
      managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
      authorityGeneration: 2,
      governanceDecisionId: GOVERNANCE_DECISION_ID,
      decisionActorId: "person@example.test",
      decisionAt: AUTHORITY_CREATED_AT,
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
    expect(() => buildMemoryMembershipManagementAuthorityEventV1({
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ACTOR_ID,
      granteeActorId: DECISION_ACTOR_ID,
      managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
      authorityGeneration: 2,
      governanceDecisionId: GOVERNANCE_DECISION_ID,
      decisionActorId: OTHER_ACTOR_ID,
      decisionAt: "2026-09-05T09:30:00Z",
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
  });

  it("requires opaque governance evidence and exact event-type pairing", () => {
    const completeInput = {
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ACTOR_ID,
      granteeActorId: DECISION_ACTOR_ID,
      managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
      authorityGeneration: 2,
      governanceDecisionId: GOVERNANCE_DECISION_ID,
      decisionActorId: OTHER_ACTOR_ID,
      decisionAt: AUTHORITY_CREATED_AT,
      state: "held" as const,
      lifecycleRevision: 0 as const,
    };
    const {
      governanceDecisionId: _governanceDecisionId,
      ...withoutGovernanceDecision
    } = completeInput;
    void _governanceDecisionId;

    expect(() => buildMemoryMembershipManagementAuthorityEventV1(
      withoutGovernanceDecision as unknown as
        BuildMemoryMembershipManagementAuthorityEventV1Input,
    )).toThrow();

    const event =
      buildMemoryMembershipManagementAuthorityEventV1(completeInput);
    expect(() => parseMemoryMembershipManagementAuthorityEventV1({
      ...event,
      type: MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.active,
    })).toThrow();
    expect(() => parseMemoryMembershipManagementAuthorityEventV1({
      ...event,
      payload: { ...event.payload, recordSchemaVersion: 2 },
    })).toThrow();
    expect(() => parseMemoryMembershipManagementAuthorityEventV1({
      ...event,
      payload: { ...event.payload, payloadKind: "membership_authority" },
    })).toThrow();
  });

  it("rejects unknown, content, credential, role, and reasoning fields", () => {
    const record = heldManagementAuthorityRecord();
    const event = buildMemoryMembershipManagementAuthorityEventV1({
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ACTOR_ID,
      granteeActorId: DECISION_ACTOR_ID,
      managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
      authorityGeneration: 2,
      governanceDecisionId: GOVERNANCE_DECISION_ID,
      decisionActorId: OTHER_ACTOR_ID,
      decisionAt: AUTHORITY_CREATED_AT,
      state: "held",
      lifecycleRevision: 0,
    });
    const forbiddenFields = [
      "email",
      "name",
      "role",
      "content",
      "credentials",
      "metadata",
      "evidenceIds",
      "reasoning",
      "noticeText",
      "executionScope",
    ] as const;

    for (const field of forbiddenFields) {
      expect(() => parseMemoryMembershipManagementAuthorityRecordV1({
        ...record,
        [field]: "must-not-enter-authority-evidence",
      })).toThrow();
      expect(() => parseMemoryMembershipManagementAuthorityEventV1({
        ...event,
        payload: {
          ...event.payload,
          [field]: "must-not-enter-authority-evidence",
        },
      })).toThrow();
    }
    expect(() => parseMemoryMembershipManagementAuthorityEventV1({
      ...event,
      unexpected: true,
    })).toThrow();
  });

  it("binds record evidence structurally without validating governance authority", () => {
    const record = heldManagementAuthorityRecord();
    const event = buildMemoryMembershipManagementAuthorityEventV1({
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ACTOR_ID,
      granteeActorId: DECISION_ACTOR_ID,
      managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
      authorityGeneration: 2,
      governanceDecisionId: GOVERNANCE_DECISION_ID,
      decisionActorId: OTHER_ACTOR_ID,
      decisionAt: AUTHORITY_CREATED_AT,
      state: "held",
      lifecycleRevision: 0,
    });
    const mismatches = [
      ["tenantId", OTHER_TENANT_ID],
      ["subjectActorId", OTHER_ACTOR_ID],
      ["granteeActorId", SUBJECT_ACTOR_ID],
      ["managementAuthorityId", "membership-authority:other"],
      ["authorityGeneration", 3],
      ["decisionActorId", SUBJECT_ACTOR_ID],
      ["decisionAt", AUTHORITY_ACTIVATED_AT],
    ] as const;

    for (const [field, value] of mismatches) {
      expect(() =>
        assertMemoryMembershipManagementAuthorityRecordEventBindingV1(
          record,
          {
            ...event,
            payload: { ...event.payload, [field]: value },
          },
        )
      ).toThrow(/does not authorize a membership change/i);
    }

    const otherOpaqueGovernanceEvidence = {
      ...event,
      payload: {
        ...event.payload,
        governanceDecisionId: "governance:other-unresolved-evidence",
      },
    };
    expect(
      assertMemoryMembershipManagementAuthorityRecordEventBindingV1(
        record,
        otherOpaqueGovernanceEvidence,
      ),
    ).toMatchObject({
      managementAuthorityId: MANAGEMENT_AUTHORITY_ID,
      decisionActorId: OTHER_ACTOR_ID,
    });

    const activeEvent = buildMemoryMembershipManagementAuthorityEventV1({
      tenantId: event.payload.tenantId,
      subjectActorId: event.payload.subjectActorId,
      granteeActorId: event.payload.granteeActorId,
      managementAuthorityId: event.payload.managementAuthorityId,
      authorityGeneration: event.payload.authorityGeneration,
      governanceDecisionId: event.payload.governanceDecisionId,
      decisionActorId: event.payload.decisionActorId,
      decisionAt: AUTHORITY_ACTIVATED_AT,
      state: "active",
      lifecycleRevision: 1,
    });
    expect(() =>
      assertMemoryMembershipManagementAuthorityRecordEventBindingV1(
        record,
        activeEvent,
      )
    ).toThrow(/does not authorize a membership change/i);
  });
});

describe("memory authority event contracts", () => {
  it("builds every membership-epoch lifecycle variant with a stable type pair", () => {
    const variants = [
      {
        state: "held",
        lifecycleRevision: 0,
        type: MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.held,
      },
      {
        state: "active",
        lifecycleRevision: 1,
        type: MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.active,
      },
      {
        state: "revoked",
        lifecycleRevision: 1,
        type: MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.revoked,
      },
      {
        state: "revoked",
        lifecycleRevision: 2,
        type: MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.revoked,
      },
    ] as const;

    for (const variant of variants) {
      const event = buildMemoryMembershipEpochEventV1({
        ...membershipBase(),
        state: variant.state,
        lifecycleRevision: variant.lifecycleRevision,
      } as BuildMemoryMembershipEpochEventV1Input);
      expect(event.type).toBe(variant.type);
      expect(event.payload).toMatchObject({
        schemaVersion: 1,
        recordSchemaVersion: 1,
        payloadKind: "memory_membership_epoch",
        state: variant.state,
        lifecycleRevision: variant.lifecycleRevision,
        membershipManagementAuthorityId: "authority:membership.manage.v1",
      });
      expect(parseMemoryMembershipEpochEventV1(event)).toEqual(event);
    }
  });

  it("builds every purpose-entitlement lifecycle variant with decision authority", () => {
    const variants = [
      {
        state: "held",
        lifecycleRevision: 0,
        type: MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.held,
      },
      {
        state: "active",
        lifecycleRevision: 1,
        type: MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.active,
      },
      {
        state: "revoked",
        lifecycleRevision: 1,
        type: MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.revoked,
      },
      {
        state: "revoked",
        lifecycleRevision: 2,
        type: MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.revoked,
      },
    ] as const;

    for (const variant of variants) {
      const event = buildMemoryPurposeEntitlementEventV1({
        ...entitlementBase(),
        state: variant.state,
        lifecycleRevision: variant.lifecycleRevision,
      } as BuildMemoryPurposeEntitlementEventV1Input);
      expect(event.type).toBe(variant.type);
      expect(event.payload).toMatchObject({
        schemaVersion: 1,
        recordSchemaVersion: 1,
        payloadKind: "memory_purpose_entitlement",
        state: variant.state,
        lifecycleRevision: variant.lifecycleRevision,
        decisionMembershipEpoch: 3,
        entitlementManagementAuthorityId: "authority:entitlement.manage.v1",
      });
      expect(parseMemoryPurposeEntitlementEventV1(event)).toEqual(event);
    }
  });

  it("builds the metadata-only self-acknowledgement receipt", () => {
    const event = buildMemoryInformedNoticeReceiptEventV1(receiptInput());

    expect(event.type).toBe(MEMORY_INFORMED_NOTICE_RECEIPT_EVENT_TYPE);
    expect(event.payload).toEqual({
      schemaVersion: 1,
      recordSchemaVersion: 1,
      payloadKind: "memory_informed_notice_receipt",
      ...receiptInput(),
    });
    expect(parseMemoryInformedNoticeReceiptEventV1(event)).toEqual(event);
  });

  it("builds every consent-v2 lifecycle variant and preserves held attribution", () => {
    const variants = [
      {
        state: "held",
        lifecycleRevision: 0,
        decisionActorId: DECISION_ACTOR_ID,
        type: MEMORY_PURPOSE_CONSENT_EVENT_TYPES.held,
      },
      {
        state: "granted",
        lifecycleRevision: 1,
        decisionActorId: SUBJECT_ACTOR_ID,
        type: MEMORY_PURPOSE_CONSENT_EVENT_TYPES.granted,
      },
      {
        state: "revoked",
        lifecycleRevision: 1,
        decisionActorId: SUBJECT_ACTOR_ID,
        type: MEMORY_PURPOSE_CONSENT_EVENT_TYPES.revoked,
      },
      {
        state: "revoked",
        lifecycleRevision: 2,
        decisionActorId: SUBJECT_ACTOR_ID,
        type: MEMORY_PURPOSE_CONSENT_EVENT_TYPES.revoked,
      },
    ] as const;

    for (const variant of variants) {
      const event = buildMemoryPurposeConsentEventV1({
        ...consentBase(),
        state: variant.state,
        lifecycleRevision: variant.lifecycleRevision,
        decisionActorId: variant.decisionActorId,
      } as BuildMemoryPurposeConsentEventV1Input);
      expect(event.type).toBe(variant.type);
      expect(event.payload).toMatchObject({
        schemaVersion: 1,
        recordSchemaVersion: 2,
        payloadKind: "memory_purpose_consent",
        state: variant.state,
        lifecycleRevision: variant.lifecycleRevision,
        decisionActorId: variant.decisionActorId,
      });
      expect(parseMemoryPurposeConsentEventV1(event)).toEqual(event);
    }
  });

  it("rejects event-type and payload-state mismatches", () => {
    const membership = buildMemoryMembershipEpochEventV1({
      ...membershipBase(),
      state: "held",
      lifecycleRevision: 0,
    });
    const entitlement = buildMemoryPurposeEntitlementEventV1({
      ...entitlementBase(),
      state: "active",
      lifecycleRevision: 1,
    });
    const consent = buildMemoryPurposeConsentEventV1({
      ...consentBase(),
      state: "granted",
      lifecycleRevision: 1,
      decisionActorId: SUBJECT_ACTOR_ID,
    });

    expect(() => parseMemoryAuthorityEventV1({
      ...membership,
      type: MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.active,
    })).toThrow();
    expect(() => parseMemoryAuthorityEventV1({
      ...entitlement,
      type: MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.revoked,
    })).toThrow();
    expect(() => parseMemoryAuthorityEventV1({
      ...consent,
      type: MEMORY_PURPOSE_CONSENT_EVENT_TYPES.held,
    })).toThrow();
  });

  it("pins payload and record versions and requires the complete receipt tuple", () => {
    const membership = buildMemoryMembershipEpochEventV1({
      ...membershipBase(),
      state: "held",
      lifecycleRevision: 0,
    });
    const consent = buildMemoryPurposeConsentEventV1({
      ...consentBase(),
      state: "held",
      lifecycleRevision: 0,
      decisionActorId: DECISION_ACTOR_ID,
    });

    expect(() => parseMemoryAuthorityEventV1({
      ...membership,
      payload: { ...membership.payload, schemaVersion: 2 },
    })).toThrow();
    expect(() => parseMemoryAuthorityEventV1({
      ...membership,
      payload: { ...membership.payload, recordSchemaVersion: 2 },
    })).toThrow();
    expect(() => parseMemoryAuthorityEventV1({
      ...consent,
      payload: { ...consent.payload, recordSchemaVersion: 1 },
    })).toThrow();
    expect(() => parseMemoryAuthorityEventV1({
      ...consent,
      payload: { ...consent.payload, payloadKind: "memory_consent" },
    })).toThrow();

    const { noticeReceiptId: _noticeReceiptId, ...incompleteConsent } =
      consentBase();
    void _noticeReceiptId;
    expect(() => buildMemoryPurposeConsentEventV1({
      ...incompleteConsent,
      state: "held",
      lifecycleRevision: 0,
      decisionActorId: DECISION_ACTOR_ID,
    } as unknown as BuildMemoryPurposeConsentEventV1Input)).toThrow();
  });

  it("rejects unknown, private-content, credential, and reasoning fields", () => {
    const events = [
      buildMemoryMembershipEpochEventV1({
        ...membershipBase(),
        state: "held",
        lifecycleRevision: 0,
      }),
      buildMemoryPurposeEntitlementEventV1({
        ...entitlementBase(),
        state: "held",
        lifecycleRevision: 0,
      }),
      buildMemoryInformedNoticeReceiptEventV1(receiptInput()),
      buildMemoryPurposeConsentEventV1({
        ...consentBase(),
        state: "held",
        lifecycleRevision: 0,
        decisionActorId: DECISION_ACTOR_ID,
      }),
    ];
    const forbiddenFields = [
      "noticeText",
      "content",
      "credentials",
      "reasoning",
      "metadata",
      "evidenceIds",
    ] as const;

    for (const event of events) {
      for (const field of forbiddenFields) {
        expect(() => parseMemoryAuthorityEventV1({
          ...event,
          payload: {
            ...event.payload,
            [field]: "must-not-enter-authority-evidence",
          },
        })).toThrow();
      }
      expect(() => parseMemoryAuthorityEventV1({
        ...event,
        unexpected: true,
      })).toThrow();
    }
  });

  it("rejects normalized, non-opaque, and non-canonical actor identities", () => {
    expect(() => buildMemoryMembershipEpochEventV1({
      ...membershipBase(),
      tenantId: ` ${TENANT_ID}`,
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
    expect(() => buildMemoryMembershipEpochEventV1({
      ...membershipBase(),
      subjectActorId: "person@example.com",
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
    expect(() => buildMemoryMembershipEpochEventV1({
      ...membershipBase(),
      decisionActorId: SUBJECT_ACTOR_ID.toUpperCase(),
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
    expect(() => buildMemoryPurposeEntitlementEventV1({
      ...entitlementBase(),
      entitlementManagementAuthorityId: " authority:entitlement.manage.v1",
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
    expect(() => buildMemoryInformedNoticeReceiptEventV1({
      ...receiptInput(),
      noticeReceiptId: `${NOTICE_RECEIPT_ID} `,
    })).toThrow();
  });

  it("rejects missing management authorities and invalid generation coordinates", () => {
    const {
      membershipManagementAuthorityId: _membershipAuthority,
      ...membershipWithoutAuthority
    } = membershipBase();
    const {
      entitlementManagementAuthorityId: _entitlementAuthority,
      ...entitlementWithoutAuthority
    } = entitlementBase();
    void _membershipAuthority;
    void _entitlementAuthority;

    expect(() => buildMemoryMembershipEpochEventV1({
      ...membershipWithoutAuthority,
      state: "held",
      lifecycleRevision: 0,
    } as unknown as BuildMemoryMembershipEpochEventV1Input)).toThrow();
    expect(() => buildMemoryPurposeEntitlementEventV1({
      ...entitlementWithoutAuthority,
      state: "held",
      lifecycleRevision: 0,
    } as unknown as BuildMemoryPurposeEntitlementEventV1Input)).toThrow();
    expect(() => buildMemoryMembershipEpochEventV1({
      ...membershipBase(),
      membershipEpoch: 0,
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
    expect(() => buildMemoryPurposeEntitlementEventV1({
      ...entitlementBase(),
      entitlementGeneration: Number.MAX_SAFE_INTEGER + 1,
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
    expect(() => buildMemoryPurposeEntitlementEventV1({
      ...entitlementBase(),
      decisionMembershipEpoch: 0,
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
  });

  it("rejects invalid lifecycle revision matrices", () => {
    expect(() => buildMemoryMembershipEpochEventV1({
      ...membershipBase(),
      state: "held",
      lifecycleRevision: 1,
    } as unknown as BuildMemoryMembershipEpochEventV1Input)).toThrow();
    expect(() => buildMemoryPurposeEntitlementEventV1({
      ...entitlementBase(),
      state: "active",
      lifecycleRevision: 2,
    } as unknown as BuildMemoryPurposeEntitlementEventV1Input)).toThrow();
    expect(() => buildMemoryPurposeConsentEventV1({
      ...consentBase(),
      state: "granted",
      lifecycleRevision: 0,
      decisionActorId: SUBJECT_ACTOR_ID,
    } as unknown as BuildMemoryPurposeConsentEventV1Input)).toThrow();
    expect(() => buildMemoryPurposeConsentEventV1({
      ...consentBase(),
      state: "revoked",
      lifecycleRevision: 3,
      decisionActorId: SUBJECT_ACTOR_ID,
    } as unknown as BuildMemoryPurposeConsentEventV1Input)).toThrow();
  });

  it("rejects malformed timestamps, digests, and notice versions", () => {
    expect(() => buildMemoryMembershipEpochEventV1({
      ...membershipBase(),
      decisionAt: "2026-09-05T09:30:00Z",
      state: "held",
      lifecycleRevision: 0,
    })).toThrow();
    expect(() => buildMemoryInformedNoticeReceiptEventV1({
      ...receiptInput(),
      noticeSha256: "A".repeat(64),
    })).toThrow();
    expect(() => buildMemoryInformedNoticeReceiptEventV1({
      ...receiptInput(),
      noticeContractVersion: 32_768,
    })).toThrow();
  });

  it("enforces receipt self acknowledgement and presentation ordering", () => {
    expect(() => buildMemoryInformedNoticeReceiptEventV1({
      ...receiptInput(),
      acknowledgedByActorId: OTHER_ACTOR_ID,
    })).toThrow(/self acknowledgement/i);
    expect(() => buildMemoryInformedNoticeReceiptEventV1({
      ...receiptInput(),
      presentedAt: "2026-09-05T09:30:01.000Z",
    })).toThrow(/before presentation/i);
  });

  it("enforces consent-v2 self decisions for grants and revocations", () => {
    expect(() => buildMemoryPurposeConsentEventV1({
      ...consentBase(),
      state: "granted",
      lifecycleRevision: 1,
      decisionActorId: OTHER_ACTOR_ID,
    })).toThrow(/self decisions/i);
    expect(() => buildMemoryPurposeConsentEventV1({
      ...consentBase(),
      state: "revoked",
      lifecycleRevision: 2,
      decisionActorId: OTHER_ACTOR_ID,
    })).toThrow(/self decisions/i);
  });

  it("rejects export and forget as standing-consent or notice-receipt purposes", () => {
    for (const purposeId of ["memory.export.v1", "memory.forget.v1"]) {
      expect(() => buildMemoryInformedNoticeReceiptEventV1({
        ...receiptInput(),
        purposeId,
      })).toThrow(/request-bound evidence/i);
      expect(() => buildMemoryPurposeConsentEventV1({
        ...consentBase(),
        purposeId,
        state: "held",
        lifecycleRevision: 0,
        decisionActorId: DECISION_ACTOR_ID,
      })).toThrow(/request-bound evidence/i);
    }
  });

  it("asserts only the exact six-coordinate structural receipt binding", () => {
    const receipt = buildMemoryInformedNoticeReceiptEventV1(
      receiptInput(),
    ).payload;
    const heldConsent = buildMemoryPurposeConsentEventV1({
      ...consentBase(),
      state: "held",
      lifecycleRevision: 0,
      decisionActorId: DECISION_ACTOR_ID,
    }).payload;

    const binding = assertMemoryConsentReceiptStructuralBindingV1(
      receipt,
      heldConsent,
    );
    expect(binding).toEqual({
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ACTOR_ID,
      purposeId: PURPOSE_ID,
      consentGeneration: 5,
      membershipEpoch: 3,
      noticeReceiptId: NOTICE_RECEIPT_ID,
    });
    expect(Object.isFrozen(binding)).toBe(true);

    const mismatches = [
      ["tenantId", OTHER_TENANT_ID],
      ["subjectActorId", OTHER_ACTOR_ID],
      ["purposeId", "memory.retrieve.v1"],
      ["consentGeneration", 6],
      ["membershipEpoch", 4],
      ["noticeReceiptId", "notice-receipt:other"],
    ] as const;
    for (const [field, value] of mismatches) {
      expect(() => assertMemoryConsentReceiptStructuralBindingV1(
        receipt,
        { ...heldConsent, [field]: value },
      )).toThrow(/structural binding mismatch/i);
    }
  });

  it("returns frozen copies from builders and parsers", () => {
    const input = {
      ...membershipBase(),
      state: "held" as const,
      lifecycleRevision: 0 as const,
    };
    const built = buildMemoryMembershipEpochEventV1(input);
    const parsed = parseMemoryAuthorityEventV1({
      type: built.type,
      payload: { ...built.payload },
    });

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.payload)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payload)).toBe(true);
    expect(built.payload).not.toBe(input);
    expect(parsed).not.toBe(built);
    expect(parsed.payload).not.toBe(built.payload);
  });

  it("keeps the public event-type vocabulary closed", () => {
    expect(memoryAuthorityEventTypeSchema.options).toEqual([
      "memory.membership_management_authority.held",
      "memory.membership_management_authority.activated",
      "memory.membership_management_authority.revoked",
      "memory.membership_epoch.held",
      "memory.membership_epoch.activated",
      "memory.membership_epoch.revoked",
      "memory.purpose_entitlement.held",
      "memory.purpose_entitlement.activated",
      "memory.purpose_entitlement.revoked",
      "memory.informed_notice_receipt.recorded",
      "memory.purpose_consent.held",
      "memory.purpose_consent.granted",
      "memory.purpose_consent.revoked",
    ]);
    expect(memoryAuthorityEventTypeSchema.safeParse(
      "memory.purpose_consent.authorized",
    ).success).toBe(false);
  });
});
