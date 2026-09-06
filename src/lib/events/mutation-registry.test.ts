import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MUTATION_EVENT_CONTRACTS,
  REQUIRED_MUTATION_EVENT_DOMAINS,
  evaluateMutationProjectionReplay,
  validateMutationEventRegistry,
  type MutationEventContract,
} from "@/lib/events/mutation-registry";

describe("Phase 1 mutation event registry", () => {
  it("covers every declared Phase 1 domain with exact atomic invariants", () => {
    const validation = validateMutationEventRegistry();

    expect(validation).toMatchObject({
      domainCount: REQUIRED_MUTATION_EVENT_DOMAINS.length,
      eventedDomainCount: 10,
      noMutationSurfaceCount: 1,
      missingDomains: [],
      duplicateDomains: [],
      invalidContractIds: [],
      passed: true,
    });
    expect(validation.registrySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validation.eventTypeCount).toBeGreaterThan(50);
  });

  it("registers every workflow writer and keeps future customer records closed", () => {
    const workflows = contract("workflows");
    const customerRecords = contract("customer_records");

    expect(workflows.writerModules).toEqual([
      "src/lib/workflows/store.ts",
      "src/lib/workflows/planner.ts",
      "src/lib/workflows/executor.ts",
      "src/lib/workflows/triggers.ts",
    ]);
    expect(workflows.mutationSurfaces).toContain("plan-node executions");
    expect(workflows.mutationSurfaces).toContain("workflow triggers and deliveries");
    expect(customerRecords).toMatchObject({
      status: "no_mutation_surface",
      writerModules: [],
      mutationSurfaces: [],
      eventTypes: [],
      atomicCommit: "not_applicable",
    });
  });

  it("points only to existing writers that append domain events", async () => {
    const modules = [...new Set(
      MUTATION_EVENT_CONTRACTS.flatMap((contract) =>
        [...contract.writerModules] as string[]
      ),
    )];
    const sources = await Promise.all(modules.map(async (module) => ({
      module,
      source: await readFile(resolve(process.cwd(), module), "utf8"),
    })));

    expect(sources.length).toBeGreaterThan(10);
    for (const { module, source } of sources) {
      expect(source, module).toMatch(/append(?:Scoped)?DomainEvent/);
      expect(source, module).toMatch(/transaction|sql/);
    }
  });

  it("fails closed for a missing domain or weakened atomic contract", () => {
    expect(validateMutationEventRegistry(
      MUTATION_EVENT_CONTRACTS.filter((entry) => entry.domain !== "tools"),
    )).toMatchObject({ missingDomains: ["tools"], passed: false });

    const weakened = MUTATION_EVENT_CONTRACTS.map((entry) =>
      entry.domain === "memory"
        ? { ...entry, atomicCommit: "not_applicable" as const }
        : entry
    ) as readonly MutationEventContract[];
    expect(validateMutationEventRegistry(weakened)).toMatchObject({
      invalidContractIds: ["memory.atomic-events.v1"],
      passed: false,
    });
  });

  it("replays every evented-domain projection with exact parity", () => {
    expect(evaluateMutationProjectionReplay()).toEqual({
      projectionCount: 10,
      matchedProjectionCount: 10,
      parityBasisPoints: 10_000,
      passed: true,
    });
  });
});

function contract(domain: MutationEventContract["domain"]) {
  return MUTATION_EVENT_CONTRACTS.find((entry) => entry.domain === domain)!;
}
