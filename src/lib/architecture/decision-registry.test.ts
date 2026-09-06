import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_DECISION_REGISTRY_VERSION,
  REQUIRED_ARCHITECTURE_DECISIONS,
} from "@/lib/architecture/decision-registry";

const decisionFiles = new Map([
  ["ADR-005", "005-canonical-truth.md"],
  ["ADR-006", "006-agent-identity.md"],
  ["ADR-007", "007-object-storage.md"],
  ["ADR-008", "008-a2a-boundary.md"],
  ["ADR-009", "009-ap2-boundary.md"],
  ["ADR-010", "010-workspace-model.md"],
  ["ADR-011", "011-native-api.md"],
]);

describe("architecture decision registry", () => {
  it("pins every accepted Phase 0 decision to its accepted ADR", async () => {
    expect(ARCHITECTURE_DECISION_REGISTRY_VERSION).toBe(1);
    expect(REQUIRED_ARCHITECTURE_DECISIONS).toHaveLength(7);
    expect(new Set(REQUIRED_ARCHITECTURE_DECISIONS.map(({ id }) => id)).size)
      .toBe(REQUIRED_ARCHITECTURE_DECISIONS.length);

    for (const decision of REQUIRED_ARCHITECTURE_DECISIONS) {
      expect(decision.status).toBe("accepted");
      const file = decisionFiles.get(decision.id);
      expect(file).toBeDefined();
      const contents = await readFile(
        path.join(process.cwd(), "docs", "adr", file as string),
        "utf8",
      );
      expect(contents).toContain(`ADR ${decision.id.slice(4)}:`);
      expect(contents).toContain("Status: Accepted");
    }
  });
});

