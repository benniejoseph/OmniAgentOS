import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODELS, deploymentModel } from "@/lib/models/default-models";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deployment default models", () => {
  it("uses the model the environment names for a role, else the role's default", () => {
    vi.stubEnv("OPENAI_AGENT_MODEL", "  gpt-5.5  ");
    vi.stubEnv("OPENAI_OCR_MODEL", "   ");
    vi.stubEnv("ANTHROPIC_FAST_MODEL", "");

    expect(deploymentModel("agent")).toBe("gpt-5.5");
    expect(deploymentModel("ocr")).toBe("gpt-4o-mini");
    expect(deploymentModel("anthropicFast")).toBe("claude-haiku-4-5");
  });

  it("documents each role's variable with its default in the example environment", () => {
    const example = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");

    for (const { env, model } of Object.values(DEFAULT_MODELS)) {
      expect(example.split("\n")).toContain(`${env}=${model}`);
    }
  });
});
