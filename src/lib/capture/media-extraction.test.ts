import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  resolve: vi.fn(),
  structured: vi.fn(),
}));

vi.mock("@/lib/config", () => ({ AGENT_MODEL: "gpt-5" }));
vi.mock("@/lib/openai/client", () => ({
  createStructuredResponse: mocks.structured,
}));
vi.mock("@/lib/models/gateway", () => ({
  generateModelStructured: mocks.generate,
}));
vi.mock("@/lib/settings/runtime-models", () => ({
  resolveRuntimeModelAssignment: mocks.resolve,
}));

import {
  mediaTurnId,
  type CaptureMediaTurn,
} from "@/lib/capture/media-contracts";
import { extractCaptureMediaInsights } from "@/lib/capture/media-extraction";

function turn(
  index: number,
  text: string,
  speaker: CaptureMediaTurn["speaker"],
): CaptureMediaTurn {
  const input = {
    segmentId: `capture_segment_${index}`,
    segmentIndex: index,
    sourceAudioSha256: String(index + 1).repeat(64),
    startMilliseconds: index * 2_000,
    endMilliseconds: (index + 1) * 2_000,
    languageTag: "en-US",
    speaker,
    text,
  };
  return { ...input, turnId: mediaTurnId(input) };
}

beforeEach(() => {
  mocks.generate.mockReset();
  mocks.resolve.mockReset().mockResolvedValue({
    configured: true,
    bind: <T>(request: T) => request,
  });
  mocks.structured.mockReset();
});

describe("cited media extraction", () => {
  it("binds native extraction to one provider attempt and current authority", async () => {
    const sample = turn(0, "A reviewed statement.", { label: "A", identity: "diarized" });
    const scope = { tenantId: "tenant-a", actorId: "actor-a", sourceStreamId: "capture-a", operation: "structured_generation" as const, purpose: "capture.media.insights.extract" };
    mocks.generate.mockRejectedValue(new Error("Response lost")); const beforeProvider = vi.fn(async () => undefined);
    await expect(extractCaptureMediaInsights({ turns: [sample], usageScope: scope, singleAttempt: true, beforeProvider })).rejects.toThrow("Response lost");
    expect(beforeProvider).toHaveBeenCalledOnce(); expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1, allowCrossProviderFallback: false }));
    expect(mocks.generate).toHaveBeenCalledOnce();
    mocks.generate.mockClear();
    await expect(extractCaptureMediaInsights({ turns: [sample], usageScope: scope, singleAttempt: true, beforeProvider: async () => { throw new Error("Consent changed"); } })).rejects.toThrow("Consent changed");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("turns only exact transcript references into timestamped insights", async () => {
    const ownerTurn = turn(0, "I will send the plan tomorrow.", {
      label: "A",
      identity: "known",
      participantId: "participant-a",
      displayName: "Asha",
    });
    const decisionTurn = turn(1, "We agreed to renew for one year.", {
      label: "B",
      identity: "diarized",
    });
    mocks.generate.mockResolvedValue({
      model: "assigned-planner",
      text: JSON.stringify({
      turnLanguages: [
        { turnId: ownerTurn.turnId, languageTag: "en-US" },
        { turnId: decisionTurn.turnId, languageTag: "en-US" },
      ],
      chapters: [{
        title: "Renewal",
        text: "The renewal term and follow-up were discussed.",
        citationTurnIds: [ownerTurn.turnId, decisionTurn.turnId],
      }],
      summary: {
        text: "The account will renew and receive a plan tomorrow.",
        citationTurnIds: [ownerTurn.turnId, decisionTurn.turnId],
      },
      actionItems: [{
        text: "Send the plan tomorrow.",
        citationTurnIds: [ownerTurn.turnId],
        ownerParticipantId: "participant-a",
        dueAt: null,
        ownershipEvidence: "explicit",
        dueDateEvidence: "unconfirmed",
      }],
      decisions: [{
        text: "Renew for one year.",
        citationTurnIds: [decisionTurn.turnId],
      }],
      }),
    });

    const extracted = await extractCaptureMediaInsights({
      turns: [ownerTurn, decisionTurn],
      usageScope: {
        tenantId: "tenant-a",
        actorId: "actor-a",
        sourceStreamId: "capture-a",
        operation: "structured_generation",
        purpose: "capture.media.insights.extract",
      },
    });

    expect(extracted.summary.citations).toEqual([
      expect.objectContaining({
        turnId: ownerTurn.turnId,
        speakerParticipantId: "participant-a",
        startMilliseconds: 0,
      }),
      expect.objectContaining({
        turnId: decisionTurn.turnId,
        speakerLabel: "B",
        startMilliseconds: 2_000,
      }),
    ]);
    expect(extracted.actionItems[0]).toMatchObject({
      ownerParticipantId: "participant-a",
      ownershipEvidence: "explicit",
    });
    expect(extracted.chapters[0]).toMatchObject({
      startMilliseconds: 0,
      endMilliseconds: 4_000,
    });
    expect(extracted.model).toBe("assigned-planner");
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      scope: "planner",
    }));
  });

  it("rejects fabricated citations outside the bounded transcript", async () => {
    const sourceTurn = turn(0, "We discussed renewal.", {
      label: "A",
      identity: "diarized",
    });
    mocks.structured.mockResolvedValue(JSON.stringify({
      turnLanguages: [],
      chapters: [],
      summary: { text: "Renewal was discussed.", citationTurnIds: ["fabricated"] },
      actionItems: [],
      decisions: [],
    }));

    await expect(extractCaptureMediaInsights({ turns: [sourceTurn] }))
      .rejects.toThrow(/outside its bounded transcript/i);
  });
});
