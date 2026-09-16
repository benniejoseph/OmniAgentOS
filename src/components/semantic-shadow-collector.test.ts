import { describe, expect, it } from "vitest";

import {
  mergeSemanticShadowJobs,
  parseSemanticShadowJob,
  semanticShadowBatchSize,
} from "@/components/semantic-shadow-collector";

describe("semantic shadow collector state", () => {
  it("bounds collection to the missing episode and diversity targets", () => {
    expect(semanticShadowBatchSize(shadowStats(0, 0))).toBe(24);
    expect(semanticShadowBatchSize(shadowStats(20, 5))).toBe(4);
    expect(semanticShadowBatchSize(shadowStats(24, 4))).toBe(4);
    expect(semanticShadowBatchSize(shadowStats(24, 6))).toBe(0);
  });

  it("accepts only the public semantic job projection", () => {
    expect(parseSemanticShadowJob({
      id: "job-1",
      status: "running",
      progress: {
        stage: "generating_enrichment",
        shadowOnly: false,
        privatePayload: "must-not-be-copied",
      },
      payload: { actorId: "private-actor" },
    }, "thread-1")).toEqual({
      id: "job-1",
      status: "running",
      progress: {
        stage: "generating_enrichment",
        shadowOnly: true,
      },
      threadId: "thread-1",
    });
    expect(parseSemanticShadowJob({ id: "job-2", status: "unknown" }))
      .toBeUndefined();
  });

  it("retains local thread attribution when a polled job becomes terminal", () => {
    expect(mergeSemanticShadowJobs(
      [{ id: "job-1", status: "running", threadId: "thread-1" }],
      [{
        id: "job-1",
        status: "completed",
        progress: {
          stage: "completed",
          outcome: "enriched",
          shadowOnly: true,
        },
      }],
    )).toEqual([{
      id: "job-1",
      status: "completed",
      threadId: "thread-1",
      progress: {
        stage: "completed",
        outcome: "enriched",
        shadowOnly: true,
      },
    }]);
  });
});

function shadowStats(currentEpisodeCount: number, distinctThreadCount: number) {
  return {
    currentEpisodeCount,
    distinctThreadCount,
    minimumEpisodeTarget: 24 as const,
    minimumThreadTarget: 6 as const,
    sampleReadyForHumanReview: currentEpisodeCount >= 24 &&
      distinctThreadCount >= 6,
    activationReady: false as const,
    deterministicSummariesActive: true as const,
    shadowOnly: true as const,
    rankingEffect: "none" as const,
  };
}
