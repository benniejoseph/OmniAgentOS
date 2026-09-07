import { describe, expect, it } from "vitest";

import {
  buildSalesforceRecordRevision,
  normalizeSalesforceRecord,
  salesforceConnectionId,
} from "@/lib/customer-success/salesforce-contracts";
import { salesforceFactValue } from "@/lib/customer-success/salesforce-projection";

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

function revision(
  objectType: "Account" | "Contact" | "Opportunity" | "Case" | "Task" | "Event" | "Asset" | "Contract",
  record: Record<string, unknown>,
) {
  return buildSalesforceRecordRevision({
    ...identity,
    observation: normalizeSalesforceRecord({
      objectType,
      sourceKind: "backfill",
      observedAt: "2026-09-07T10:01:00.000Z",
      record: {
        SystemModstamp: "2026-09-07T10:00:00.000Z",
        ...record,
      },
    }),
    receivedAt: "2026-09-07T10:02:00.000Z",
  });
}

describe("Salesforce Account 360 projection", () => {
  it("maps provider records into typed provider-neutral facts", () => {
    expect(salesforceFactValue(revision("Account", {
      Id: "001000000000001AAA",
      Name: "Acme",
      Industry: "Software",
      Website: "https://acme.example",
    }))).toMatchObject({ kind: "organization", name: "Acme" });
    expect(salesforceFactValue(revision("Contact", {
      Id: "003000000000001AAA",
      AccountId: "001000000000001AAA",
      Name: "Ada Lovelace",
      Email: "ada@example.test",
      Title: "CTO",
    }))).toMatchObject({ kind: "contact", email: "ada@example.test" });
    expect(salesforceFactValue(revision("Opportunity", {
      Id: "006000000000001AAA",
      AccountId: "001000000000001AAA",
      Name: "Expansion",
      StageName: "Proposal",
      Amount: 1250.5,
      CurrencyIsoCode: "USD",
      CloseDate: "2026-10-01",
    }))).toMatchObject({
      kind: "opportunity",
      amountMinor: 125050,
      currency: "USD",
    });
    expect(salesforceFactValue(revision("Case", {
      Id: "500000000000001AAA",
      AccountId: "001000000000001AAA",
      Subject: "Production issue",
      Status: "New",
      Priority: "High",
    }))).toMatchObject({ kind: "case", severity: "high" });
  });

  it("maps activities, assets and contracts without granting CRM write authority", () => {
    expect(salesforceFactValue(revision("Task", {
      Id: "00T000000000001AAA",
      AccountId: "001000000000001AAA",
      Subject: "Call customer",
      ActivityDate: "2026-09-08",
    }))).toMatchObject({ kind: "interaction", channel: "call" });
    expect(salesforceFactValue(revision("Asset", {
      Id: "02i000000000001AAA",
      AccountId: "001000000000001AAA",
      Name: "Enterprise seats",
      Status: "Installed",
      Quantity: 25,
    }))).toMatchObject({ kind: "product", status: "active", quantity: 25 });
    expect(salesforceFactValue(revision("Contract", {
      Id: "800000000000001AAA",
      AccountId: "001000000000001AAA",
      Status: "Activated",
      EndDate: "2027-09-07",
    }))).toMatchObject({ kind: "renewal", status: "committed" });
  });
});
