import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const publicEntryFiles = [
  "src/components/marketing/public-header.tsx",
  "src/components/marketing/docs-guide.tsx",
  "src/components/onboarding/demo-workspace.tsx",
  "src/components/onboarding/login-form.tsx",
];

describe("private public entry surface", () => {
  it("does not render public signup links or intake requests", async () => {
    const sources = await Promise.all(
      publicEntryFiles.map((file) => readFile(path.resolve(file), "utf8")),
    );
    const source = sources.join("\n");

    expect(source).not.toContain('href="/signup"');
    expect(source).not.toContain("/api/onboarding/request-access");
    expect(source).not.toContain("Get access");
    expect(source).not.toContain("Request workspace");
    expect(source).not.toContain('href="/onboarding"');
    expect(source).not.toContain("Start onboarding");
  });
});
