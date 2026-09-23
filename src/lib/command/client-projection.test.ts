import { describe, expect, it } from "vitest";

import {
  canonicalClientAgentMode,
  projectClientThreadSummaries,
  projectClientThreadTurns,
} from "@/lib/command/client-projection";

describe("Command client projections", () => {
  it("defaults empty and invalid persisted modes to orchestrate", () => {
    expect(canonicalClientAgentMode("")).toBe("orchestrate");
    expect(canonicalClientAgentMode("general")).toBe("orchestrate");
    expect(canonicalClientAgentMode(undefined)).toBe("orchestrate");
  });

  it("preserves supported persisted modes", () => {
    expect(canonicalClientAgentMode("research")).toBe("research");
    expect(canonicalClientAgentMode("execute")).toBe("execute");
  });

  it("drops malformed turns instead of passing crashable content to React", () => {
    expect(projectClientThreadTurns([
      { id: "turn-a", role: "assistant", content: "Ready", createdAt: "2026-09-10T00:00:00Z", runId: "run-a" },
      { id: "turn-b", role: "assistant", content: { unsafe: true } },
      { id: "turn-c", role: "system", content: "hidden" },
      null,
    ])).toEqual([{
      id: "turn-a",
      role: "assistant",
      content: "Ready",
      createdAt: "2026-09-10T00:00:00Z",
      runId: "run-a",
    }]);
  });

  it("projects only render-safe thread summaries and normalizes their mode", () => {
    expect(projectClientThreadSummaries([
      { id: "thread-a", title: "Media task", updatedAt: "now", mode: "execute" },
      { id: "thread-b", title: "Old task", mode: "unexpected" },
      { id: "thread-c", title: { unsafe: true }, mode: "research" },
    ], ["orchestrate", "research", "execute", "learn"] as const, "orchestrate")).toEqual([
      { id: "thread-a", title: "Media task", updatedAt: "now", mode: "execute" },
      { id: "thread-b", title: "Old task", updatedAt: "", mode: "orchestrate" },
    ]);
  });
});
