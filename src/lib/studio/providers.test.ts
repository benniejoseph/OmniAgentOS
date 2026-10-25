import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  estimateStudioProviderCost,
  getStudioCapability,
  STUDIO_CAPABILITIES,
  validateStudioProviderInputs,
} from "./capabilities";
import {
  buildStudioGoogleRequest,
  cancelStudioProvider,
  getStudioProviderStatus,
  materializeStudioProviderOutput,
  recordStudioProviderUsage,
  resolveStudioCapabilities,
  resolveStudioProviderRoute,
  submitStudioProvider,
} from "./providers";
import type {
  StudioProviderContext,
  StudioProviderHandle,
  StudioProviderRequest,
} from "./provider-types";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  connections: vi.fn(),
  credentials: vi.fn(),
  ledger: vi.fn(),
  publicFetch: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image",
  GEMINI_VIDEO_MODEL: "gemini-omni-1.1-flash",
  hasGeminiKey: () => true,
}));
vi.mock("@/lib/settings/specialized-runtime", () => ({
  resolveSpecializedRuntime: mocks.runtime,
}));
vi.mock("@/lib/settings/store", () => ({
  listProviderConnections: mocks.connections,
  getProviderCredentials: mocks.credentials,
}));
vi.mock("@/lib/usage/ledger", () => ({ recordAiUsageSafely: mocks.ledger }));
vi.mock("@/lib/security/network", () => ({
  fetchPublicHttpUrl: mocks.publicFetch,
}));

const ctx: StudioProviderContext = {
  tenantId: "tenant-test",
  actorId: "actor-test",
  sourceStreamId: "studio-test",
};
const request = (
  patch: Partial<StudioProviderRequest> = {},
): StudioProviderRequest => ({
  capabilityId: "google-image-generate",
  prompt: "An original abstract arch",
  parameters: {},
  references: [],
  submissionKey: "attempt-1",
  ...patch,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
let png: Buffer;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("GEMINI_API_KEY", "test-only-key");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mocks.runtime.mockImplementation(async (input) => ({
    configured: true,
    source: "deployment_environment",
    provider: "google",
    model: input.deploymentModel,
    usageReceipt: { credentialSource: "deployment_environment" },
  }));
  mocks.connections.mockResolvedValue([]);
  mocks.ledger.mockResolvedValue({ id: "saved" });
  png = await readFile(
    new URL("../../../public/studio-demo/image-1.png", import.meta.url),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function liveRequest(patch: Partial<StudioProviderRequest> = {}) {
  const req = request(patch);
  req.route = await resolveStudioProviderRoute(req.capabilityId, ctx);
  return req;
}
function completed(id = "v1_job") {
  return {
    id,
    status: "completed",
    model: "gemini-3.1-flash-image",
    steps: [
      {
        type: "model_output",
        content: [
          {
            type: "image",
            mime_type: "image/png",
            data: png.toString("base64"),
          },
        ],
      },
    ],
    usage: { total_input_tokens: 10, total_output_tokens: 1120 },
  };
}
async function runningHandle(): Promise<StudioProviderHandle> {
  fetchMock.mockResolvedValueOnce(
    json({ id: "v1_job", status: "in_progress" }),
  );
  return (await submitStudioProvider(await liveRequest(), ctx)).handle;
}

describe("Studio capability contracts", () => {
  it("gives every supported operation matching roles and conservative cost bounds", () => {
    expect(STUDIO_CAPABILITIES).toHaveLength(10);
    expect(new Set(STUDIO_CAPABILITIES.map((c) => c.id)).size).toBe(10);
    for (const cap of STUDIO_CAPABILITIES) expect(cap.schemaVersion).toBe(1);
    expect(
      getStudioCapability("google-video-frames")?.inputRoles.map((r) => r.role),
    ).toEqual(["start_frame", "end_frame"]);
    expect(
      estimateStudioProviderCost("google-image-generate").maximumUsd! +
        estimateStudioProviderCost("google-video-image").maximumUsd!,
    ).toBeCloseTo(3.2768, 6);
    expect(estimateStudioProviderCost("demo-video-text").estimatedUsd).toBe(0);
    expect(
      estimateStudioProviderCost("google-video-text", { resolution: "4k" })
        .status,
    ).toBe("unknown");
  });
  it("rejects unsupported controls, fractional counts and missing/wrong references", () => {
    const bad = validateStudioProviderInputs({
      capabilityId: "google-video-frames",
      prompt: "Move",
      parameters: { duration: 4, outputCount: 1.5 },
      references: [{ role: "start_frame", mediaType: "audio/mpeg" }],
    });
    expect(bad.issues.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        "unsupported_parameter",
        "invalid_parameter",
        "reference_type",
        "missing_reference",
      ]),
    );
    expect(
      validateStudioProviderInputs({
        capabilityId: "google-image-generate",
        prompt: "Paint",
        references: [{ role: "reference", mediaType: "image/png" }],
      }).issues[0].code,
    ).toBe("unsupported_reference");
  });
  it("fails closed when configured assignment is unavailable or an unsupported model", async () => {
    mocks.runtime.mockResolvedValue({
      configured: false,
      warning: "Reconnect Google.",
    });
    const caps = await resolveStudioCapabilities(ctx);
    expect(
      caps
        .filter((c) => !c.demo)
        .every(
          (c) => !c.available && c.unavailableReason === "Reconnect Google.",
        ),
    ).toBe(true);
    expect(caps.filter((c) => c.demo).every((c) => c.available)).toBe(true);
    mocks.runtime.mockResolvedValue({
      configured: true,
      provider: "google",
      model: "unknown-image-model",
    });
    await expect(
      resolveStudioProviderRoute("google-image-generate", ctx),
    ).rejects.toMatchObject({ code: "unsupported_route" });
  });
});

describe("Studio provider submission and recovery", () => {
  it("builds one asynchronous stored interaction with exact roles and nonremovable token limits", () => {
    const ref = {
      assetId: "asset-one",
      contentSha256: createHash("sha256").update(png).digest("hex"),
      mediaType: "image/png",
      role: "start_frame",
      bytes: png,
    };
    const body = buildStudioGoogleRequest(
      request({
        capabilityId: "google-video-frames",
        references: [{ ...ref, role: "end_frame" }, ref],
      }),
    );
    expect(body).toMatchObject({
      model: "gemini-omni-1.1-flash",
      background: true,
      store: true,
      stream: false,
      response_format: { type: "video", resolution: "720p" },
      generation_config: { max_output_tokens: 65536 },
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("previous_interaction_id");
    expect((body.input as Array<Record<string, unknown>>).at(-1)?.text).toBe(
      "[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]\nAn original abstract arch",
    );
    expect(buildStudioGoogleRequest(request()).generation_config).toEqual({
      max_output_tokens: 8192,
    });
  });
  it("requires the accepted route pin and unchanged reference content before any paid call", async () => {
    await expect(submitStudioProvider(request(), ctx)).rejects.toMatchObject({
      code: "route_changed",
    });
    const req = await liveRequest({
      capabilityId: "google-image-edit",
      references: [
        {
          assetId: "asset",
          contentSha256: "bad",
          mediaType: "image/png",
          role: "reference",
          bytes: png,
        },
      ],
    });
    await expect(submitStudioProvider(req, ctx)).rejects.toMatchObject({
      code: "reference_changed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("never resubmits an ambiguous network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("connection reset"));
    await expect(
      submitStudioProvider(await liveRequest(), ctx),
    ).rejects.toMatchObject({ disposition: "uncertain_submission" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("distinguishes explicit rejection from a server failure with unknown acceptance", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 400));
    await expect(
      submitStudioProvider(await liveRequest(), ctx),
    ).rejects.toMatchObject({
      disposition: "rejected",
      code: "provider_http_400",
    });
    fetchMock.mockResolvedValueOnce(json({}, 503));
    await expect(
      submitStudioProvider(await liveRequest(), ctx),
    ).rejects.toMatchObject({ disposition: "uncertain_submission" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("polls the saved ID, extracts only final model media, and uses one stable usage identity", async () => {
    const handle = await runningHandle();
    const body = completed();
    body.steps.unshift({
      type: "thought",
      content: [
        { type: "image", mime_type: "image/png", data: "PRIVATE_THOUGHT" },
      ],
    });
    fetchMock.mockImplementation(async () => json(body));
    const first = await getStudioProviderStatus(handle, ctx);
    const second = await getStudioProviderStatus(handle, ctx);
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    if (first.status !== "completed") throw new Error("Expected completion.");
    expect(first.outputs).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain("PRIVATE_THOUGHT");
    expect(
      fetchMock.mock.calls
        .slice(1)
        .every(
          ([url, init]) => url.endsWith("/v1_job") && init.method === "GET",
        ),
    ).toBe(true);
    expect(mocks.ledger).not.toHaveBeenCalled();
    await recordStudioProviderUsage(first, ctx);
    await recordStudioProviderUsage(second, ctx);
    expect(mocks.ledger.mock.calls[0][0].id).toBe(
      mocks.ledger.mock.calls[1][0].id,
    );
    expect(mocks.ledger.mock.calls[0][0]).toMatchObject({
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      providerCallCount: 1,
      providerRequestId: "v1_job",
    });
  });
  it("prevents cross-owner status retrieval", async () => {
    const handle = await runningHandle();
    await expect(
      getStudioProviderStatus(handle, { ...ctx, actorId: "someone-else" }),
    ).rejects.toMatchObject({ code: "invalid_handle" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("uses the original vault credential for polling after assignment changes", async () => {
    mocks.runtime.mockImplementation(async (input) => ({
      configured: true,
      source: "tenant_assignment",
      provider: "google",
      model: input.deploymentModel,
      usageReceipt: {
        credentialSource: "tenant_vault",
        assignmentId: "route-1",
        assignmentRevision: 2,
        assignmentConfigurationSha256: "hash",
      },
    }));
    const connection = {
      id: "connection-1",
      provider: "google",
      source: "tenant_vault",
      status: "connected",
      enabled: true,
      credentialVersion: 3,
    };
    mocks.connections.mockResolvedValue([connection]);
    mocks.credentials.mockResolvedValue({
      connection,
      credentials: { apiKey: "vault-test-key" },
    });
    const handle = await runningHandle();
    mocks.runtime.mockRejectedValue(
      new Error("Current assignment no longer usable"),
    );
    fetchMock.mockResolvedValueOnce(json(completed()));
    expect((await getStudioProviderStatus(handle, ctx)).status).toBe(
      "completed",
    );
    expect(mocks.credentials).toHaveBeenLastCalledWith({
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      connectionId: "connection-1",
    });
    mocks.credentials.mockResolvedValue({
      connection: { ...connection, credentialVersion: 4 },
      credentials: { apiKey: "rotated-key" },
    });
    await expect(getStudioProviderStatus(handle, ctx)).rejects.toMatchObject({
      code: "credential_changed",
    });
  });
  it("keeps completed output when provider completion wins the cancellation race", async () => {
    const handle = await runningHandle();
    fetchMock.mockResolvedValueOnce(json(completed()));
    const result = await cancelStudioProvider(handle, ctx);
    expect(result.status).toBe("completed");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("/v1_job/cancel");
  });
  it("reports provider moderation and token cutoff distinctly from success", async () => {
    const handle = await runningHandle();
    fetchMock.mockResolvedValueOnce(
      json({
        id: handle.requestId,
        status: "failed",
        error: { code: "SAFETY" },
      }),
    );
    expect((await getStudioProviderStatus(handle, ctx)).status).toBe(
      "moderated",
    );
    fetchMock.mockResolvedValueOnce(
      json({ id: handle.requestId, status: "incomplete" }),
    );
    const result = await getStudioProviderStatus(handle, ctx);
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("token limit"),
    });
  });
});

describe("Studio output ingestion", () => {
  it("saves multi-megabyte base64 media without regex stack exhaustion", async () => {
    const large = Buffer.concat([
      png,
      Buffer.alloc(4 * 1024 * 1024 - png.length),
    ]);
    const media = await materializeStudioProviderOutput(
      {
        id: "large",
        mediaType: "image/png",
        filename: "large.png",
        demo: false,
        source: { kind: "inline", base64: large.toString("base64") },
      },
      ctx,
    );
    expect(media.bytes.byteLength).toBe(large.byteLength);
    expect(createHash("sha256").update(media.bytes).digest("hex")).toBe(
      createHash("sha256").update(large).digest("hex"),
    );
  });
  it("accepts full-length graph node IDs in persisted submission keys", async () => {
    const result = await submitStudioProvider(
      request({
        capabilityId: "demo-image-generate",
        submissionKey: `studio_run_00000000-0000-0000-0000-000000000000:${"n".repeat(160)}:1`,
      }),
      ctx,
    );
    expect(result.status).toBe("completed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses bundled demo bytes without a public filesystem directory", async () => {
    const result = await submitStudioProvider(
      request({ capabilityId: "demo-video-text" }),
      ctx,
    );
    if (result.status !== "completed") throw new Error("Expected completion.");
    const workingDirectory = vi
      .spyOn(process, "cwd")
      .mockReturnValue("/serverless/without-public");
    try {
      const media = await materializeStudioProviderOutput(
        result.outputs[0],
        ctx,
      );
      expect(media.bytes.byteLength).toBeGreaterThan(10_000);
      expect(media.demo).toBe(true);
    } finally {
      workingDirectory.mockRestore();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("replays complete demo collections and a playable MP4 without any provider call", async () => {
    const result = await submitStudioProvider(
      request({
        capabilityId: "demo-image-generate",
        parameters: { outputCount: 3 },
      }),
      ctx,
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completion.");
    expect(result.outputs).toHaveLength(3);
    const images = await Promise.all(
      result.outputs.map((output) =>
        materializeStudioProviderOutput(output, ctx),
      ),
    );
    expect(
      new Set(
        images.map((i) => createHash("sha256").update(i.bytes).digest("hex")),
      ).size,
    ).toBe(3);
    const video = await submitStudioProvider(
      request({ capabilityId: "demo-video-text" }),
      ctx,
    );
    if (video.status !== "completed") throw new Error("Expected completion.");
    const media = await materializeStudioProviderOutput(video.outputs[0], ctx);
    expect(media).toMatchObject({
      demo: true,
      durationSeconds: 3,
      mediaType: "video/mp4",
    });
    expect(Buffer.from(media.bytes).includes(Buffer.from("moov"))).toBe(true);
    expect(Buffer.from(media.bytes).includes(Buffer.from("avc1"))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.ledger).not.toHaveBeenCalled();
  });
  it("retries durable output retrieval without another submission", async () => {
    const handle = await runningHandle();
    fetchMock.mockResolvedValueOnce(json(completed()));
    const result = await getStudioProviderStatus(handle, ctx);
    if (result.status !== "completed") throw new Error("Expected completion.");
    const saved = JSON.parse(JSON.stringify(result.outputs[0]));
    expect((await materializeStudioProviderOutput(saved, ctx)).bytes).toEqual(
      png,
    );
    expect((await materializeStudioProviderOutput(saved, ctx)).bytes).toEqual(
      png,
    );
    expect(
      fetchMock.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(1);
  });
  it("rejects internal/untrusted media URLs without fetching and preserves retrieval semantics", async () => {
    await expect(
      materializeStudioProviderOutput(
        {
          id: "one",
          mediaType: "image/png",
          filename: "image.png",
          demo: false,
          source: { kind: "remote", url: "https://127.0.0.1/private" },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ disposition: "retrieval" });
    expect(mocks.publicFetch).not.toHaveBeenCalled();
  });
  it("handles expired provider URLs as save failures without generation", async () => {
    mocks.publicFetch.mockResolvedValue(json({}, 403));
    await expect(
      materializeStudioProviderOutput(
        {
          id: "one",
          mediaType: "image/png",
          filename: "image.png",
          demo: false,
          source: {
            kind: "remote",
            url: "https://storage.googleapis.com/fixture/expired",
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "output_retrieval_failed",
      disposition: "retrieval",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not accept HTML masquerading as generated media", async () => {
    await expect(
      materializeStudioProviderOutput(
        {
          id: "one",
          mediaType: "image/png",
          filename: "image.png",
          demo: false,
          source: {
            kind: "inline",
            base64: Buffer.from("<html>fake</html>").toString("base64"),
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid_media" });
  });
});
