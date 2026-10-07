import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  client: vi.fn(),
  resolveRuntime: vi.fn(),
  classifyResponse: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/config")>(),
  WEB_SEARCH_MODEL: "gpt-4o-mini",
  WEB_SEARCH_TIMEOUT_MS: 60_000,
  hasOpenAIKey: () => true,
}));
vi.mock("@/lib/settings/specialized-runtime", () => ({
  resolveSpecializedRuntime: mocks.resolveRuntime,
}));
vi.mock("@/lib/openai/client", () => ({
  classifyOpenAITerminalResponse: mocks.classifyResponse,
  getOpenAIClient: (options: unknown) => {
    mocks.client(options);
    return { responses: { create: mocks.create } };
  },
}));
vi.mock("@/lib/usage/ledger", () => ({ recordAiUsageSafely: mocks.recordUsage }));

import { getModelProviderResponseReceipt, ModelProviderError } from "@/lib/models/types";
import { citationIdForWebUrl } from "@/lib/rag/citations";
import { runLiveWebSearch } from "@/lib/web-search/search";

const scope = {
  tenantId: "tenant-search",
  actorId: "actor-search",
  sourceStreamId: "run:search",
  operation: "web_search" as const,
  purpose: "tool.web.search",
  correlationId: "search:correlation",
};
const sourceUrl = "https://example.com/fact";
const usage = { input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 };

function searchCall(id = "ws_1", status = "completed", sources = [{ type: "url", url: sourceUrl }]) {
  return { id, type: "web_search_call", status, action: { type: "search", sources } };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_search",
    status: "completed",
    output_text: "A source-backed answer.",
    output: [searchCall()],
    usage,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveRuntime.mockResolvedValue({
    configured: true,
    provider: "openai",
    model: "gpt-4o-mini",
    usageReceipt: { credentialSource: "deployment_environment" },
    withApiKey: <T>(run: (apiKey?: string) => T) => run(undefined),
  });
  mocks.create.mockResolvedValue(response());
  vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
    "gpt-4o-mini": { input: 1, output: 4, webSearch: 0.01 },
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("live web search provider boundary", () => {
  it("requires the hosted tool, bounds ordinary research, and disables hidden retries", async () => {
    const result = await runLiveWebSearch({ query: "Current fact", usageScope: scope });

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      store: false,
      tool_choice: "required",
      max_tool_calls: 3,
      max_output_tokens: 2_000,
      tools: [{ type: "web_search", search_context_size: "medium" }],
      include: ["web_search_call.results", "web_search_call.action.sources"],
    }), expect.objectContaining({ maxRetries: 0, timeout: 60_000, signal: expect.any(AbortSignal) }));
    expect(result).toMatchObject({ summary: "A source-backed answer.", sourceCount: 1 });
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
  });

  it("passes requested domains unchanged even on the default model", async () => {
    await runLiveWebSearch({ query: "Current fact", allowedDomains: ["example.com"] });
    expect(mocks.create.mock.calls[0][0].tools).toEqual([{
      type: "web_search",
      search_context_size: "medium",
      filters: { allowed_domains: ["example.com"] },
    }]);
  });

  it("reports unsupported filters without retrying an unrestricted search", async () => {
    mocks.create.mockRejectedValue(Object.assign(new Error("Unsupported parameter: tools[0].filters"), {
      status: 400,
      param: "tools[0].filters",
    }));
    await expect(runLiveWebSearch({
      query: "Current fact", allowedDomains: ["example.com"], usageScope: scope,
    })).rejects.toThrow("rejected the requested domain filters");
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", failureKind: "invalid_request", retryable: false,
      usage: { searchQueryCount: 0 },
    }));
  });

  it.each([
    ["memory-only output", { output: [] }, "no completed search call", 0],
    ["a failed hosted search", { output: [searchCall("ws_1", "failed")] }, "did not complete", 1],
    ["an unfinished hosted search", { output: [searchCall("ws_1", "searching")] }, "did not complete", 1],
    ["an empty answer", { output_text: "   " }, "no answer", 1],
    ["no source URLs", { output: [searchCall("ws_1", "completed", [])] }, "no usable source URLs", 1],
    ["invalid source URLs", { output: [searchCall("ws_1", "completed", [{ type: "url", url: "data:text/plain,not-a-source" }])] }, "no usable source URLs", 1],
  ])("rejects %s and keeps its actual token receipt", async (_name, overrides, message, searchCount) => {
    mocks.create.mockResolvedValue(response(overrides as Record<string, unknown>));
    const failure = await runLiveWebSearch({ query: "Current fact", usageScope: scope }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelProviderError);
    expect((failure as Error).message).toContain(message);
    expect(getModelProviderResponseReceipt(failure)).toMatchObject({
      usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 },
      providerRequestId: "resp_search",
      estimatedCostUsd: 0.0014 + Number(searchCount) * 0.01,
    });
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      usage: expect.objectContaining({ inputTokens: 1_000, searchQueryCount: searchCount }),
      providerCallCount: 1,
      attemptCount: 1,
      failedAttemptCount: 1,
    }));
  });

  it("counts returned hosted calls rather than assuming one query", async () => {
    mocks.create.mockResolvedValue(response({ output: [searchCall("ws_1"), searchCall("ws_2")] }));
    await runLiveWebSearch({ query: "Compare current facts", usageScope: scope });
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ searchQueryCount: 2 }),
      estimatedCostUsd: 0.0214,
      providerCallCount: 1,
    }));
  });

  it("merges citation metadata, normalizes URLs, and keeps cited sources under the limit", async () => {
    const citedUrl = "https://example.com/cited";
    mocks.create.mockResolvedValue(response({
      output: [
        searchCall("ws_1", "completed", [
          { type: "url", url: "https://example.com/uncited" },
          { type: "url", url: citedUrl },
        ]),
        { type: "message", content: [{ type: "output_text", annotations: [{
          type: "url_citation", url: `${citedUrl}#section`, title: "Cited primary source", snippet: "Useful evidence.",
        }] }] },
      ],
    }));
    const result = await runLiveWebSearch({ query: "Current fact", maxSources: 1 });
    expect(result.sources).toEqual([{
      citationId: citationIdForWebUrl(citedUrl),
      url: citedUrl,
      title: "Cited primary source",
      snippet: "Useful evidence.",
    }]);
  });

  it("keeps provider terminal failures and their usage receipts", async () => {
    mocks.classifyResponse.mockReturnValue(new ModelProviderError("Provider incomplete", "openai", "unavailable", true));
    const failure = await runLiveWebSearch({ query: "Current fact", usageScope: scope }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe("Provider incomplete");
    expect(getModelProviderResponseReceipt(failure)?.providerRequestId).toBe("resp_search");
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
  });

  it("does not dispatch an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Stopped by caller"));
    await expect(runLiveWebSearch({ query: "Current fact", abortSignal: controller.signal, usageScope: scope })).rejects.toThrow("Stopped by caller");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", failureKind: "abort", providerCallCount: 0, attemptCount: 0,
      usage: { searchQueryCount: 0 },
    }));
  });

  it("accepts a search that completes beyond the former 25-second cutoff without retrying", async () => {
    vi.useFakeTimers();
    mocks.create.mockImplementation((_body, options: { signal: AbortSignal }) => new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        reject(options.signal.reason);
      };
      const timer = setTimeout(() => {
        options.signal.removeEventListener("abort", cancel);
        resolve(response());
      }, 35_000);
      options.signal.addEventListener("abort", cancel, { once: true });
    }));
    const pending = runLiveWebSearch({ query: "Compare primary sources", usageScope: scope });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][1].signal.aborted).toBe(false);
    expect(mocks.recordUsage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({ sourceCount: 1 });
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed", latencyMs: 35_000, providerCallCount: 1, attemptCount: 1,
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { afterMs: 35_000, reason: "Stopped by caller" },
    { afterMs: 15_000, reason: "Run wall deadline exceeded" },
  ])("honors an earlier caller abort after $afterMs ms: $reason", async ({ afterMs, reason }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mocks.create.mockImplementation((_body, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const pending = runLiveWebSearch({ query: "Current fact", abortSignal: controller.signal, usageScope: scope });
    const assertion = expect(pending).rejects.toThrow(reason);
    setTimeout(() => controller.abort(new Error(reason)), afterMs);
    await vi.advanceTimersByTimeAsync(afterMs);
    await assertion;
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", failureKind: "abort", retryable: false,
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a slow provider once and clears its timer", async () => {
    vi.useFakeTimers();
    mocks.create.mockImplementation((_body, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const pending = runLiveWebSearch({ query: "Current fact", usageScope: scope });
    const assertion = expect(pending).rejects.toThrow("timed out after 60000ms");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(mocks.create.mock.calls[0][1].signal.aborted).toBe(false);
    expect(mocks.recordUsage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", failureKind: "timeout", retryable: false }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
