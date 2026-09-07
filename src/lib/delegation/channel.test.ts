import { describe, expect, it } from "vitest";

import {
  buildDelegationMessageV1,
  buildSharedMissionArtifactV1,
  parseDelegationMessageV1,
  parseSharedMissionArtifactV1,
} from "@/lib/delegation/channel";
import {
  buildDelegationTaskV1,
  transitionDelegationTaskV1,
} from "@/lib/delegation/lifecycle";
import { buildContract } from "@/lib/delegation/test-fixtures";

function workingTask() {
  let task = buildDelegationTaskV1(buildContract());
  task = transitionDelegationTaskV1({
    task,
    transition: { to: "accepted" },
    at: "2026-09-07T06:00:10.000Z",
  }).task;
  return transitionDelegationTaskV1({
    task,
    transition: { to: "working" },
    at: "2026-09-07T06:00:20.000Z",
  }).task;
}

describe("delegation Mission channel contracts", () => {
  it("builds a bounded untrusted message that cannot mutate state", () => {
    const message = buildDelegationMessageV1({
      task: workingTask(),
      missionId: "mission:one",
      recipients: { parent: true, delegationTaskIds: ["delegation-task:sibling"] },
      kind: "progress",
      body: "The evidence pass is ready for parent review.",
      createdAt: "2026-09-07T06:00:30.000Z",
    });
    expect(message).toMatchObject({
      messageId: expect.stringMatching(/^delegation-message:[a-f0-9]{64}$/),
      sender: { agentId: "sentinel", taskId: "delegation-task:delegation:one" },
      boundary: {
        contentIsUntrusted: true,
        mutatesStateDirectly: false,
        authorityImpact: "none",
        privateMemoryIncluded: false,
      },
    });
    expect(() => parseDelegationMessageV1({ ...message, body: "changed" }))
      .toThrow(/integrity/);
  });

  it("builds an explicitly shared content artifact with digest-only evidence refs", () => {
    const artifact = buildSharedMissionArtifactV1({
      task: workingTask(),
      missionId: "mission:one",
      recipients: { parent: true, delegationTaskIds: [] },
      kind: "analysis",
      title: "Verified findings",
      mediaType: "application/json",
      content: JSON.stringify({ findings: ["One"] }),
      evidenceIds: ["evidence:one"],
      toolExecutionIds: ["tool:one"],
      createdAt: "2026-09-07T06:00:30.000Z",
    });
    expect(artifact).toMatchObject({
      artifactId: expect.stringMatching(/^delegation-artifact:[a-f0-9]{64}$/),
      byteCount: Buffer.byteLength(artifact.content, "utf8"),
      evidenceIds: ["evidence:one"],
      toolExecutionIds: ["tool:one"],
    });
    expect(() => parseSharedMissionArtifactV1({ ...artifact, contentSha256: "0".repeat(64) }))
      .toThrow(/integrity/);
  });

  it("rejects credentials, recipient-free messages, and inactive senders", () => {
    expect(() => buildDelegationMessageV1({
      task: workingTask(),
      missionId: "mission:one",
      recipients: { parent: true, delegationTaskIds: [] },
      kind: "question",
      body: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      createdAt: "2026-09-07T06:00:30.000Z",
    })).toThrow(/credential/);
    expect(() => buildDelegationMessageV1({
      task: workingTask(),
      missionId: "mission:one",
      recipients: { parent: false, delegationTaskIds: [] },
      kind: "question",
      body: "Which evidence should I inspect?",
      createdAt: "2026-09-07T06:00:30.000Z",
    })).toThrow(/recipient/);
    expect(() => buildSharedMissionArtifactV1({
      task: buildDelegationTaskV1(buildContract()),
      missionId: "mission:one",
      recipients: { parent: true, delegationTaskIds: [] },
      kind: "result",
      title: "Result",
      mediaType: "text/plain",
      content: "Not started.",
      createdAt: "2026-09-07T06:00:30.000Z",
    })).toThrow(/state/);
  });
});
