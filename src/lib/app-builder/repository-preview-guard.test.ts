import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/lib/app-services/app-builder.ts", "utf8");

describe("App Builder repository preview guard", () => {
  it("accepts a repository workspace only when an exact reviewed delivery is supplied", () => {
    expect(source).toContain(
      "const repositoryWorkspace = await getBuilderRepositoryWorkspace(session.sandboxName);",
    );
    expect(source).toContain(
      "if (repositoryWorkspace && !value.repositoryDeliveryId)",
    );
    expect(source).not.toContain(
      "if (await getBuilderRepositoryWorkspace(session.sandboxName))",
    );
    expect(source).toContain(
      "repositoryDelivery.checkpointId !== checkpoint.id",
    );
    expect(source).toContain(
      "repositoryDelivery.verificationId !== verification.id",
    );
    expect(source).toContain(
      "repositoryDelivery.workspaceSha256 !== checkpoint.workspaceSha256",
    );
  });
});
