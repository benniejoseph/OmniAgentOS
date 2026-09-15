import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sandboxMocks = vi.hoisted(() => ({
  get: vi.fn(),
  runCommand: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: { get: sandboxMocks.get },
}));

describe("App Builder sandbox source search", () => {
  beforeEach(() => {
    sandboxMocks.get.mockReset();
    sandboxMocks.runCommand.mockReset();
    sandboxMocks.get.mockResolvedValue({ runCommand: sandboxMocks.runCommand });
  });

  it("preserves indexed byte sizes for filename and content matches", async () => {
    sandboxMocks.runCommand
      .mockResolvedValueOnce(commandResult("docs/audit.md\t7168\napp/page.tsx\t512\n"))
      .mockResolvedValueOnce(commandResult("./app/page.tsx\n./next-env.d.ts\n"));
    const { searchBuilderFiles } = await import("@/lib/app-builder/sandbox");

    await expect(searchBuilderFiles({ sandboxName: "asael-test", query: "audit" })).resolves.toEqual([
      { path: "app/page.tsx", kind: "file", size: 512 },
      { path: "docs/audit.md", kind: "file", size: 7168 },
    ]);
    expect(sandboxMocks.runCommand).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cmd: "find",
      args: expect.arrayContaining(["-printf", "%P\\t%s\\n"]),
    }));
  });

  it("binds embedded previews to the validated Asael parent origin", async () => {
    const source = await readFile(
      new URL("./sandbox.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("ASAEL_PREVIEW_PARENT_ORIGIN");
    expect(source).toContain('delete responseHeaders["x-frame-options"]');
    expect(source).toContain('startsWith("frame-ancestors ")');
    expect(source).toContain('responseHeaders["referrer-policy"] = "no-referrer"');
    expect(source).toContain("builderPreviewParentOrigin()");
  });
});

function commandResult(stdout: string) {
  return {
    exitCode: 0,
    stdout: async () => stdout,
  };
}
