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

  it("describes deterministic readiness without presenting legacy browser evidence as a gate", () => {
    expect(source).toContain("Build logs and static route smokes must both pass");
    expect(source).toContain("Readiness receipt");
    expect(source).toContain("retired from readiness");
    expect(source).not.toContain("Checks + visual evidence passed");
    expect(source).not.toContain("desktop/mobile captures must all resolve");
    expect(source).not.toContain("Visual smoke");
  });
});
