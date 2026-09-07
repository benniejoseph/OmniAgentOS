import { afterEach, describe, expect, it } from "vitest";

import {
  getSalesforceWriteConfiguration,
  parseSalesforceRecordWriteInput,
  providerRecordIdSha256,
  salesforceWriteExpectedTargetStateSha256,
  salesforceWriteExternalKey,
  salesforceWriteOperationId,
} from "@/lib/customer-success/salesforce-write-contracts";

const accountId = `customer-account:${"a".repeat(64)}`;

afterEach(() => {
  delete process.env.SALESFORCE_WRITE_ENABLED;
  delete process.env.SALESFORCE_WRITE_EXTERNAL_ID_FIELD;
});

describe("guarded Salesforce write contracts", () => {
  it("keeps writes disabled until both explicit gates are valid", () => {
    expect(getSalesforceWriteConfiguration()).toMatchObject({
      enabled: false,
      configured: false,
      externalIdField: null,
      mode: "approval_required",
    });
    process.env.SALESFORCE_WRITE_ENABLED = "true";
    process.env.SALESFORCE_WRITE_EXTERNAL_ID_FIELD = "Asael_Idempotency_Key__c";
    expect(getSalesforceWriteConfiguration()).toMatchObject({
      enabled: true,
      configured: true,
      externalIdField: "Asael_Idempotency_Key__c",
    });
  });

  it("accepts only reviewed fields and exact update revisions", () => {
    expect(parseSalesforceRecordWriteInput(
      "app.customer_accounts.salesforce.contact.update",
      {
        accountId,
        expectedAccountRevision: 3,
        recordId: "003000000000001AAA",
        expectedProviderModifiedAt: "2026-09-07T12:00:00.000Z",
        fields: { Email: "owner@example.test" },
      },
    )).toMatchObject({ fields: { Email: "owner@example.test" } });
    expect(() => parseSalesforceRecordWriteInput(
      "app.customer_accounts.salesforce.contact.update",
      {
        accountId,
        expectedAccountRevision: 3,
        recordId: "003000000000001AAA",
        expectedProviderModifiedAt: "2026-09-07T12:00:00.000Z",
        fields: { OwnerId: "005000000000001AAA" },
      },
    )).toThrow();
  });

  it("derives stable provider and operation identities without raw IDs", () => {
    const executionId = "idem_example";
    expect(salesforceWriteExternalKey(executionId)).toMatch(/^asael_[a-f0-9]{58}$/);
    expect(salesforceWriteOperationId(executionId)).toMatch(/^salesforce-write:[a-f0-9]{64}$/);
    expect(providerRecordIdSha256("003000000000001AAA")).toMatch(/^[a-f0-9]{64}$/);
    expect(salesforceWriteExpectedTargetStateSha256({
      toolId: "app.customer_accounts.salesforce.task.create",
      executionId,
      value: {
        accountId,
        expectedAccountRevision: 3,
        fields: {
          Subject: "Call customer",
          Description: null,
          ActivityDate: "2026-09-09",
          Status: "Not Started",
          Priority: "Normal",
        },
      },
    })).toMatch(/^[a-f0-9]{64}$/);
  });
});
