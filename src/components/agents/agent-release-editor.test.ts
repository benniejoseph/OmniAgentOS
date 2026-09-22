import { describe, expect, it } from "vitest";

import {
  agentReleaseActionForSelection,
  agentReleaseMatchesAgent,
  agentReleasePinMetadata,
} from "@/components/agents/agent-release-editor";
import type { AgentReleaseView } from "@/lib/agents/release-store";

describe("P7.5 Agent release editor", () => {
  it("requires evaluation before promotion and reuses the exact receipt", () => {
    const draft = release();
    expect(agentReleaseActionForSelection(draft, 2)).toEqual({
      kind: "evaluate",
      definitionVersion: 2,
    });
    const evaluation = {
      schemaVersion: 1 as const,
      version: "p7.5-agent-release-evaluation:1" as const,
      evaluationId: `agent-release-evaluation:${"a".repeat(64)}`,
      agentId: "agent-one",
      definitionId: "definition:custom:agent-one",
      definitionVersion: 2,
      definitionVersionId: "definition:custom:agent-one:v2",
      definitionSha256: "b".repeat(64),
      baselineDefinitionVersion: 1,
      baselineDefinitionVersionId: "definition:custom:agent-one:v1",
      baselineDefinitionSha256: "c".repeat(64),
      policyVersionId: "agent-release-policy:1" as const,
      direction: "promotion" as const,
      changedFields: ["instructions" as const],
      checks: {
        exactOwnerBinding: true as const,
        versionTransition: true as const,
        immutableDefinitionDigest: true as const,
        personaContract: true as const,
        skillPins: true as const,
        authorityExcluded: true as const,
        materialChange: true as const,
      },
      verdict: "passed" as const,
      evaluatedAt: "2026-09-07T04:00:00.000Z",
      evaluationSha256: "d".repeat(64),
    };
    expect(agentReleaseActionForSelection({
      ...draft,
      evaluations: [evaluation],
    }, 2)).toMatchObject({
      kind: "promote",
      evaluationId: evaluation.evaluationId,
    });
  });

  it("offers an older evaluated version only as rollback", () => {
    const current = release({
      activeDefinitionVersion: 2,
      activeDefinitionVersionId: "definition:custom:agent-one:v2",
      latestDefinitionVersion: 2,
      latestDefinitionVersionId: "definition:custom:agent-one:v2",
      previousDefinitionVersion: 1,
      previousDefinitionVersionId: "definition:custom:agent-one:v1",
      versions: [
        { definitionVersion: 1, definitionVersionId: "definition:custom:agent-one:v1", publishedAt: "2026-09-07T01:00:00.000Z", active: false },
        { definitionVersion: 2, definitionVersionId: "definition:custom:agent-one:v2", publishedAt: "2026-09-07T02:00:00.000Z", active: true },
      ],
    });
    expect(agentReleaseActionForSelection(current, 1)).toEqual({
      kind: "evaluate",
      definitionVersion: 1,
    });
    expect(agentReleaseActionForSelection(current, 2)).toBeUndefined();
  });

  it("projects exact safe version pins and only exposes digests present in the read model", () => {
    const draft = release();
    expect(agentReleasePinMetadata(draft, 2)).toEqual({
      activeDefinitionVersionId: "definition:custom:agent-one:v1",
      selectedDefinitionVersionId: "definition:custom:agent-one:v2",
      selectedDefinitionSha256: null,
      evaluationId: null,
      evaluationSha256: null,
    });
    const evaluation = {
      schemaVersion: 1 as const,
      version: "p7.5-agent-release-evaluation:1" as const,
      evaluationId: `agent-release-evaluation:${"a".repeat(64)}`,
      agentId: "agent-one",
      definitionId: "definition:custom:agent-one",
      definitionVersion: 2,
      definitionVersionId: "definition:custom:agent-one:v2",
      definitionSha256: "b".repeat(64),
      baselineDefinitionVersion: 1,
      baselineDefinitionVersionId: "definition:custom:agent-one:v1",
      baselineDefinitionSha256: "c".repeat(64),
      policyVersionId: "agent-release-policy:1" as const,
      direction: "promotion" as const,
      changedFields: ["instructions" as const],
      checks: {
        exactOwnerBinding: true as const,
        versionTransition: true as const,
        immutableDefinitionDigest: true as const,
        personaContract: true as const,
        skillPins: true as const,
        authorityExcluded: true as const,
        materialChange: true as const,
      },
      verdict: "passed" as const,
      evaluatedAt: "2026-09-07T04:00:00.000Z",
      evaluationSha256: "d".repeat(64),
    };
    expect(agentReleasePinMetadata({ ...draft, evaluations: [evaluation] }, 2)).toMatchObject({
      selectedDefinitionSha256: "b".repeat(64),
      evaluationId: evaluation.evaluationId,
      evaluationSha256: "d".repeat(64),
    });
  });

  it("never reuses release or destructive state across Agent selection", () => {
    const first = release({ agentId: "agent-one" });
    expect(agentReleaseMatchesAgent(first, "agent-one")).toBe(true);
    expect(agentReleaseMatchesAgent(first, "agent-two")).toBe(false);
    expect(agentReleaseMatchesAgent(undefined, "agent-two")).toBe(false);
  });
});

function release(overrides: Partial<AgentReleaseView> = {}): AgentReleaseView {
  return {
    schemaVersion: 1,
    agentId: "agent-one",
    state: "active",
    releaseRevision: 1,
    activeDefinitionVersion: 1,
    activeDefinitionVersionId: "definition:custom:agent-one:v1",
    previousDefinitionVersion: null,
    previousDefinitionVersionId: null,
    latestDefinitionVersion: 2,
    latestDefinitionVersionId: "definition:custom:agent-one:v2",
    candidateEvaluation: null,
    updatedAt: "2026-09-07T01:00:00.000Z",
    retiredAt: null,
    versions: [
      { definitionVersion: 1, definitionVersionId: "definition:custom:agent-one:v1", publishedAt: "2026-09-07T01:00:00.000Z", active: true },
      { definitionVersion: 2, definitionVersionId: "definition:custom:agent-one:v2", publishedAt: "2026-09-07T02:00:00.000Z", active: false },
    ],
    evaluations: [],
    ...overrides,
  };
}
