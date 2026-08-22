import { describe, expect, it } from "vitest";
import { buildResultTimeline, toneForResultStatus } from "@/components/results-utils";

describe("result timeline", () => {
  it("merges sources by timestamp so the latest state wins", () => {
    const timeline = buildResultTimeline({
      agentRuns: [
        {
          id: "agent-1",
          prompt: "Prepare report",
          status: "completed",
          response: "Done",
          completedAt: "2026-08-19T10:00:00.000Z",
        },
      ],
      workflowRuns: [
        {
          id: "workflow-1",
          goal: "Deploy report",
          status: "running",
          updatedAt: "2026-08-19T10:05:00.000Z",
        },
      ],
      approvalItems: [
        {
          id: "approval-1",
          title: "Publish report",
          status: "waiting_approval",
          createdAt: "2026-08-19T10:10:00.000Z",
        },
      ],
    });

    expect(timeline.map((item) => item.kind)).toEqual(["approval", "workflow", "agent"]);
    expect(timeline[0].status).toBe("waiting_approval");
  });

  it("deduplicates repeated records using their newest timestamp", () => {
    const timeline = buildResultTimeline({
      agentRuns: [
        {
          id: "agent-1",
          prompt: "Prepare report",
          status: "running",
          updatedAt: "2026-08-19T10:00:00.000Z",
        },
        {
          id: "agent-1",
          prompt: "Prepare report",
          status: "completed",
          response: "Done",
          completedAt: "2026-08-19T10:05:00.000Z",
        },
      ],
      workflowRuns: [],
      approvalItems: [],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0].status).toBe("completed");
    expect(timeline[0].body).toBe("Done");
  });

  it("does not treat unknown state as healthy", () => {
    expect(toneForResultStatus("unknown")).toBe("neutral");
    expect(toneForResultStatus("canceled")).toBe("neutral");
    expect(toneForResultStatus("failed")).toBe("danger");
    expect(toneForResultStatus("completed")).toBe("success");
  });
});
