import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ledger: { heads: [] as unknown[], revisions: [] as unknown[] },
  append: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(),
  getSql: vi.fn(),
  hasDatabaseUrl: () => false,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.append,
}));
vi.mock("@/lib/storage/paths", () => ({
  getDataPath: () => "/tmp/capture-media-processing.test.json",
}));
vi.mock("@/lib/storage/json", () => ({
  readJsonFile: vi.fn(async () => structuredClone(mocks.ledger)),
  updateJsonFile: vi.fn(async (
    _path: string,
    _fallback: unknown,
    mutate: (value: typeof mocks.ledger) => typeof mocks.ledger,
  ) => {
    mocks.ledger = structuredClone(mutate(structuredClone(mocks.ledger)));
  }),
}));

import {
  mediaCitationForTurn,
  mediaTurnId,
  sha256Json,
  type CaptureMediaTurn,
} from "@/lib/capture/media-contracts";
import {
  commitCaptureMediaOutput,
  getCaptureMediaHead,
  markCaptureMediaProcessingStatus,
  queueCaptureMediaProcessing,
} from "@/lib/capture/media-store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const executionScope = createExecutionScope({
  tenantId: "tenant-a",
  initiatingActorId: "actor-a",
  executingPrincipalType: "user",
  executingPrincipalId: "actor-a",
  correlationId: "correlation-a",
  purpose: "capture.media.process",
});

beforeEach(() => {
  mocks.ledger = { heads: [], revisions: [] };
  mocks.append.mockReset().mockResolvedValue(undefined);
});

describe("capture media processing store", () => {
  it("advances a queued head and commits one immutable cited output revision", async () => {
    await queueCaptureMediaProcessing({
      tenantId: "tenant-a",
      actorId: "actor-a",
      executionScope,
      operationJobId: "job-a",
      request: {
        schemaVersion: 1,
        recordingId: "capture_recording_a",
        languageHints: ["en-US"],
        speakerMappings: [],
        rawAudioRetention: { mode: "retain" },
      },
    });
    await markCaptureMediaProcessingStatus(
      "capture_recording_a",
      { tenantId: "tenant-a", actorId: "actor-a", executionScope },
      { operationJobId: "job-a", status: "processing" },
    );
    const baseTurn = {
      segmentId: "capture_segment_a",
      segmentIndex: 0,
      sourceAudioSha256: "a".repeat(64),
      startMilliseconds: 0,
      endMilliseconds: 2_000,
      languageTag: "en-US",
      speaker: { label: "A", identity: "diarized" as const },
      text: "Send the plan tomorrow.",
    };
    const turn: CaptureMediaTurn = {
      ...baseTurn,
      turnId: mediaTurnId(baseTurn),
    };
    const citation = mediaCitationForTurn(turn);
    const output = await commitCaptureMediaOutput(
      { tenantId: "tenant-a", actorId: "actor-a", executionScope },
      "job-a",
      {
        schemaVersion: 1,
        tenantId: "tenant-a",
        ownerActorId: "actor-a",
        recordingId: "capture_recording_a",
        sourceAudioManifestSha256: sha256Json([turn.sourceAudioSha256]),
        transcriptionModel: "gpt-4o-transcribe-diarize",
        extractionModel: "gpt-5",
        languageTags: ["en-US"],
        turns: [turn],
        chapters: [],
        summary: { text: "A plan will be sent tomorrow.", citations: [citation] },
        actionItems: [],
        decisions: [],
        warnings: [],
        rawAudioRetention: { mode: "retain" },
      },
    );

    expect(output.mediaRevisionId).toBe("capture_recording_a:media:v1");
    await expect(getCaptureMediaHead("capture_recording_a", {
      tenantId: "tenant-a",
      actorId: "actor-a",
    })).resolves.toMatchObject({
      processingStatus: "ready",
      processingGeneration: 3,
      output: { outputSha256: output.outputSha256 },
    });
    expect(mocks.ledger.revisions).toHaveLength(1);
    expect(mocks.append).toHaveBeenCalledTimes(3);
  });

  it("rejects a queue write whose actor is not bound by the execution scope", async () => {
    await expect(queueCaptureMediaProcessing({
      tenantId: "tenant-a",
      actorId: "actor-b",
      executionScope,
      operationJobId: "job-a",
      request: {
        schemaVersion: 1,
        recordingId: "capture_recording_a",
        languageHints: [],
        speakerMappings: [],
        rawAudioRetention: { mode: "retain" },
      },
    })).rejects.toThrow(/execution scope/i);
  });

  it("creates a new revision when confirmed semantics change for the same audio", async () => {
    await queueCaptureMediaProcessing({
      tenantId: "tenant-a",
      actorId: "actor-a",
      executionScope,
      operationJobId: "job-a",
      request: {
        schemaVersion: 1,
        recordingId: "capture_recording_a",
        languageHints: ["en-US"],
        speakerMappings: [],
        rawAudioRetention: { mode: "retain" },
      },
    });
    const baseTurn = {
      segmentId: "capture_segment_a",
      segmentIndex: 0,
      sourceAudioSha256: "a".repeat(64),
      startMilliseconds: 0,
      endMilliseconds: 2_000,
      languageTag: "en-US",
      speaker: { label: "A", identity: "diarized" as const },
      text: "Send the plan tomorrow.",
    };
    const turn = { ...baseTurn, turnId: mediaTurnId(baseTurn) };
    const citation = mediaCitationForTurn(turn);
    const draft = {
      schemaVersion: 1 as const,
      tenantId: "tenant-a",
      ownerActorId: "actor-a",
      recordingId: "capture_recording_a",
      sourceAudioManifestSha256: sha256Json([turn.sourceAudioSha256]),
      transcriptionModel: "gpt-4o-transcribe-diarize",
      extractionModel: "gpt-5",
      languageTags: ["en-US"],
      turns: [turn],
      chapters: [],
      summary: { text: "A plan will be sent tomorrow.", citations: [citation] },
      actionItems: [],
      decisions: [],
      warnings: [],
      rawAudioRetention: { mode: "retain" as const },
    };
    const first = await commitCaptureMediaOutput(
      { tenantId: "tenant-a", actorId: "actor-a", executionScope },
      "job-a",
      draft,
    );
    const second = await commitCaptureMediaOutput(
      { tenantId: "tenant-a", actorId: "actor-a", executionScope },
      "job-a",
      {
        ...draft,
        summary: { text: "The plan is due tomorrow.", citations: [citation] },
      },
    );

    expect(first.mediaRevision).toBe(1);
    expect(second.mediaRevision).toBe(2);
    expect(mocks.ledger.revisions).toHaveLength(2);
  });
});
