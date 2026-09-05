import { describe, expect, it, vi } from "vitest";
import {
  parseExactGitRevision,
  resolveProductionSmokeRevision,
} from "../../../scripts/resolve-production-smoke-revision.mjs";

const revision = "a53a77aee2e1056f8989cc19b24b0a6a620cf084";

describe("production smoke revision resolution", () => {
  it("preserves an explicitly requested exact release revision", async () => {
    const fetchHealth = vi.fn();

    await expect(resolveProductionSmokeRevision({
      baseUrl: "https://asael.example",
      requestedRevision: revision,
      fetchHealth,
    })).resolves.toEqual({
      revision,
      source: "workflow_input",
    });
    expect(fetchHealth).not.toHaveBeenCalled();
  });

  it("pins scheduled smoke to the healthy production revision", async () => {
    await expect(resolveProductionSmokeRevision({
      baseUrl: "https://asael.example",
      fetchHealth: async () => ({ status: "healthy", revision }),
    })).resolves.toEqual({
      revision,
      source: "production_health",
    });
  });

  it("fails closed for unhealthy or non-canonical observations", async () => {
    await expect(resolveProductionSmokeRevision({
      baseUrl: "https://asael.example",
      fetchHealth: async () => ({ status: "degraded", revision }),
    })).rejects.toThrow("did not report healthy");
    await expect(resolveProductionSmokeRevision({
      baseUrl: "https://asael.example",
      fetchHealth: async () => ({ status: "healthy", revision: "a53a77a" }),
    })).rejects.toThrow("exact 40-character lowercase Git SHA");
    expect(() => parseExactGitRevision(`${revision}\nINJECTED=value`)).toThrow(
      "exact 40-character lowercase Git SHA",
    );
  });
});
