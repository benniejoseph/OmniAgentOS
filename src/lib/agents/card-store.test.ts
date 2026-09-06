import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAgentRunIdentityPin: vi.fn(),
  hasDatabaseUrl: vi.fn(() => false),
}));

vi.mock("@/lib/runs/store", () => ({
  getAgentRunIdentityPin: mocks.getAgentRunIdentityPin,
}));
vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(),
  getSql: vi.fn(),
  hasDatabaseUrl: mocks.hasDatabaseUrl,
}));

import { getAgentIdentityCardForRun } from "@/lib/agents/card-store";
import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
} from "@/lib/agents/identity-contracts";

beforeEach(() => {
  mocks.getAgentRunIdentityPin.mockReset();
  mocks.hasDatabaseUrl.mockReset().mockReturnValue(false);
});

describe("P7.2 run Agent identity card", () => {
  it("returns the exact built-in definition pinned to the run", async () => {
    const identity = buildBuiltInAgentIdentityV1({
      agentId: "mnemosyne",
      tenantId: "tenant-one",
      controllerActorId: "actor-one",
    });
    mocks.getAgentRunIdentityPin.mockResolvedValue(
      buildAgentRunIdentityPinV1({ runId: "run-one", identity }),
    );

    await expect(getAgentIdentityCardForRun("run-one", {
      tenantId: "tenant-one",
    })).resolves.toMatchObject({
      state: "ready",
      card: {
        name: "Mnemosyne",
        role: "Memory",
        persona: identity.definition.persona,
      },
    });
  });

  it("makes legacy unbound runs explicit", async () => {
    mocks.getAgentRunIdentityPin.mockResolvedValue(undefined);

    await expect(getAgentIdentityCardForRun("legacy-run", {
      tenantId: "tenant-one",
    })).resolves.toEqual({ state: "unbound" });
  });
});
