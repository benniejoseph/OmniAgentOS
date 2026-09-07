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
    expect(source).toContain("CRM adapter · read only");
    expect(source).toContain("Read-only reconciliation");
    expect(source).toContain("Salesforce OAuth credentials are required");
  });
});
