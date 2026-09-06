import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { listCaptureAssets, saveCaptureAsset } from "@/lib/capture/assets";
import {
  createCaptureRecording,
  getCaptureRecording,
  saveCaptureSegment,
} from "@/lib/capture/recordings";
import { listStreamEvents } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("Capture mutation idempotency", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "omni-capture-mutations-"),
    );
  });

  it("replays one asset write without duplicating its resource or event", async () => {
    const executionScope = scope("capture-asset-request");
    const input = {
      tenantId: "tenant-a",
      actorId: "actor-a",
      executionScope,
      filename: "evidence.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("bounded evidence"),
    };

    const first = await saveCaptureAsset(input);
    const replay = await saveCaptureAsset(input);

    expect(replay.id).toBe(first.id);
    await expect(listCaptureAssets({
      tenantId: "tenant-a",
      actorId: "actor-a",
    })).resolves.toHaveLength(1);
    await expect(listStreamEvents(`capture-asset:${first.id}`, {
      tenantId: "tenant-a",
      actorId: "actor-a",
    })).resolves.toHaveLength(1);
  });

  it("replays recording and segment creation by their derived identities", async () => {
    const recordingScope = scope("capture-recording-request");
    const first = await createCaptureRecording({
      tenantId: "tenant-a",
      actorId: "actor-a",
      executionScope: recordingScope,
    });
    const replay = await createCaptureRecording({
      tenantId: "tenant-a",
      actorId: "actor-a",
      executionScope: recordingScope,
    });
    expect(replay.id).toBe(first.id);

    const segmentScope = scope("capture-segment-request");
    const segmentInput = {
      tenantId: "tenant-a",
      actorId: "actor-a",
      executionScope: segmentScope,
      recordingId: first.id,
      segmentIndex: 0,
      mimeType: "audio/webm",
      audio: new Uint8Array([1, 2, 3, 4]),
      durationMs: 500,
    };
    const created = await saveCaptureSegment(segmentInput);
    const replayed = await saveCaptureSegment(segmentInput);

    expect(created.created).toBe(true);
    expect(replayed).toMatchObject({
      created: false,
      segment: { id: created.segment.id },
    });
    await expect(getCaptureRecording(first.id, {
      tenantId: "tenant-a",
      actorId: "actor-a",
    })).resolves.toMatchObject({ segmentCount: 1 });
    await expect(listStreamEvents(`capture-segment:${created.segment.id}`, {
      tenantId: "tenant-a",
      actorId: "actor-a",
    })).resolves.toHaveLength(1);
  });
});

function scope(correlationId: string) {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "actor-a",
    executingPrincipalType: "user",
    executingPrincipalId: "actor-a",
    correlationId,
    purpose: "capture.test",
  });
}
