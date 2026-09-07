import { describe, expect, it } from "vitest";

import {
  SALESFORCE_OBJECT_TYPES,
  buildSalesforceRecordRevision,
  initialSalesforceSyncCursor,
  normalizeSalesforceRecord,
  resolveSalesforceHead,
  salesforceConnectionId,
  salesforceRecordObservationSchema,
} from "@/lib/customer-success/salesforce-contracts";

const receivedAt = "2026-09-07T10:05:00.000Z";
const identity = {
  tenantId: "tenant-a",
  workspaceId: "workspace:personal-a",
  connectionId: salesforceConnectionId({
    tenantId: "tenant-a",
    workspaceId: "workspace:personal-a",
    organizationIdSha256: "a".repeat(64),
  }),
  organizationIdSha256: "a".repeat(64),
};

function accountRecord(modifiedAt: string, name = "Acme") {
  return normalizeSalesforceRecord({
    objectType: "Account",
    sourceKind: "delta",
    observedAt: receivedAt,
    record: {
      Id: "001000000000001AAA",
      Name: name,
      Industry: "Software",
      SystemModstamp: modifiedAt,
      Secret_Field__c: "must not cross the adapter boundary",
      attributes: { type: "Account" },
    },
  });
}

describe("Salesforce read-sync contracts", () => {
  it("creates an independent cursor for every reviewed object", () => {
    const cursor = initialSalesforceSyncCursor();
    expect(Object.keys(cursor.objects).sort()).toEqual([...SALESFORCE_OBJECT_TYPES].sort());
    expect(Object.values(cursor.objects).every((item) => item.phase === "pending"))
      .toBe(true);
  });

  it("drops unreviewed provider fields before persistence", () => {
    const observation = accountRecord("2026-09-07T10:00:00.000Z");
    expect(observation.accountExternalId).toBe("001000000000001AAA");
    expect(observation.fields).toEqual({
      Id: "001000000000001AAA",
      Name: "Acme",
      Industry: "Software",
      SystemModstamp: "2026-09-07T10:00:00.000Z",
    });
    expect(observation.fields).not.toHaveProperty("Secret_Field__c");
  });

  it("rejects a field outside the reviewed permission contract", () => {
    const observation = accountRecord("2026-09-07T10:00:00.000Z");
    expect(() => salesforceRecordObservationSchema.parse({
      ...observation,
      fields: { ...observation.fields, Password__c: "secret" },
    })).toThrow("outside the reviewed Salesforce read contract");
  });

  it("converges delayed and duplicate observations deterministically", () => {
    const first = buildSalesforceRecordRevision({
      ...identity,
      observation: accountRecord("2026-09-07T10:00:00.000Z", "Acme"),
      receivedAt,
    });
    const newer = buildSalesforceRecordRevision({
      ...identity,
      observation: accountRecord("2026-09-07T10:02:00.000Z", "Acme Global"),
      receivedAt,
    });

    expect(resolveSalesforceHead(undefined, first)).toMatchObject({
      outcome: "advanced",
      head: first,
    });
    expect(resolveSalesforceHead(first, newer)).toMatchObject({
      outcome: "advanced",
      head: newer,
    });
    expect(resolveSalesforceHead(newer, first)).toMatchObject({
      outcome: "stale",
      head: newer,
    });
    expect(resolveSalesforceHead(newer, newer)).toMatchObject({
      outcome: "duplicate",
      head: newer,
    });
  });

  it("retains same-timestamp conflicts and chooses one head independent of arrival order", () => {
    const left = buildSalesforceRecordRevision({
      ...identity,
      observation: accountRecord("2026-09-07T10:00:00.000Z", "Acme Left"),
      receivedAt,
    });
    const right = buildSalesforceRecordRevision({
      ...identity,
      observation: accountRecord("2026-09-07T10:00:00.000Z", "Acme Right"),
      receivedAt,
    });
    const leftThenRight = resolveSalesforceHead(left, right);
    const rightThenLeft = resolveSalesforceHead(right, left);

    expect(leftThenRight.conflict).toBe(true);
    expect(rightThenLeft.conflict).toBe(true);
    expect(leftThenRight.head.revisionId).toBe(rightThenLeft.head.revisionId);
  });
});
