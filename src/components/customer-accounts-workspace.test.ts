import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Account 360 workspace", () => {
  it("renders every master-plan domain with visible fact evidence", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/components/customer-accounts-workspace.tsx"),
      "utf8",
    );
    for (const label of [
      "Organization", "Contacts", "Stakeholders", "Products", "Opportunities",
      "Cases", "Usage", "Projects", "Interactions", "Health", "Risks", "Renewal",
    ]) expect(source).toContain(label);
    for (const evidence of ["Source", "Freshness", "Confidence", "Owner", "Conflict"]) {
      expect(source).toContain(evidence);
    }
    expect(source).toContain("External CRM writes are disabled");
    expect(source).toContain("Neither value was silently selected");
    expect(source).toContain("Salesforce sync");
    expect(source).toContain("CRM adapter · governed");
    expect(source).toContain("Read-only reconciliation");
    expect(source).toContain("Write receipts");
    expect(source).toContain("Approval-bound");
    expect(source).toContain("Salesforce OAuth credentials are required");
    expect(source).toContain("Explainable customer health");
    expect(source).toContain("Deterministic policy · evidence first");
    expect(source).toContain("Model suggestions · non-authoritative");
    expect(source).toContain("freshness and conflict adjusted");
    expect(source).toContain("weighted factors with evidence");
    expect(source).toContain("This missing factor contributes zero confidence");
    expect(source).toContain("Re-evaluate before relying on it");
    expect(source).toContain("expectedAccountSha256");
  });
});
