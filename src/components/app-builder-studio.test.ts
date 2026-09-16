import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/app-builder-studio.tsx", "utf8");

describe("App Builder live preview recovery", () => {
  it("remounts the embedded frame after the sandbox preview restarts", () => {
    expect(source).toContain(
      "setPreviewGeneration((generation) => generation + 1)",
    );
    expect(source).toContain(
      "key={`${snapshot.previewUrl}:${previewGeneration}`}",
    );
    expect(source).toContain('aria-label="Restart live preview"');
    expect(source).not.toContain(
      'if (command === "start_preview") await loadSession();',
    );
  });
});
