export { isLiveWebSearchExplicitlyDisabled, shouldUseLiveWebSearch } from "@/lib/web-search/intent";
import { WEB_SEARCH_MODEL, WEB_SEARCH_TIMEOUT_MS, hasOpenAIKey } from "@/lib/config";
import {
  classifyOpenAITerminalResponse,
  getOpenAIClient,
} from "@/lib/openai/client";
import {
  attachModelProviderResponseReceipt,
  getModelProviderResponseReceipt,
  ModelProviderError,
} from "@/lib/models/types";
import { estimateWebSearchCostUsd } from "@/lib/models/pricing";
import { openAIResponseUsage } from "@/lib/openai/usage";
import { citationIdForWebUrl } from "@/lib/rag/citations";
import { resolveSpecializedRuntime } from "@/lib/settings/specialized-runtime";
import { recordAiUsageSafely } from "@/lib/usage/ledger";
import type { AiUsageScope } from "@/lib/usage/types";
import type { Response, ResponseCreateParamsNonStreaming, ResponseFunctionWebSearch } from "openai/resources/responses/responses";

export type LiveWebSearchContextSize = "low" | "medium" | "high";

// The HTTP API supports max_tool_calls; SDK 6.49 declares it only on its
// WebSocket event. Keep this documented extension explicit until the SDK catches up.
// https://developers.openai.com/api/reference/python/resources/responses/methods/create
type BoundedWebSearchRequest = ResponseCreateParamsNonStreaming & { max_tool_calls: number };

export type LiveWebSearchSource = {
  citationId: string;
  title: string;
  url: string;
  snippet?: string;
};

export type LiveWebSearchResult = {
  query: string;
  searchedAt: string;
  provider: "openai.responses.web_search";
  model: string;
  summary: string;
  sources: LiveWebSearchSource[];
  sourceCount: number;
};

export async function runLiveWebSearch({
  query,
  contextSize = "medium",
  allowedDomains,
  maxSources = 8,
  abortSignal,
  usageScope,
}: {
  query: string;
  contextSize?: LiveWebSearchContextSize;
  allowedDomains?: string[];
  maxSources?: number;
  abortSignal?: AbortSignal;
  usageScope?: AiUsageScope;
}): Promise<LiveWebSearchResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("Live web search query is required.");
  }
  const runtimeModel = await resolveSpecializedRuntime({
    tenantId: usageScope?.tenantId,
    actorId: usageScope?.actorId,
    scope: "web_search",
    requiredCapability: "tools",
    deploymentProvider: "openai",
    deploymentModel: WEB_SEARCH_MODEL,
    deploymentConfigured: hasOpenAIKey(),
  });
  if (!runtimeModel.configured || runtimeModel.provider !== "openai") {
    throw new Error("Live web search does not have an active model route.");
  }
  const meteredUsageScope = usageScope
    ? { ...usageScope, ...runtimeModel.usageReceipt }
    : undefined;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error(`Web search timed out after ${WEB_SEARCH_TIMEOUT_MS}ms`)), WEB_SEARCH_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any
    ? AbortSignal.any([timeoutController.signal, ...(abortSignal ? [abortSignal] : [])])
    : timeoutController.signal;

  let searchCallCount = 0;
  let dispatched = false;
  const startedAt = Date.now();
  try {
    const searchedAt = new Date().toISOString();
    const response = await runtimeModel.withApiKey((apiKey) => {
      combinedSignal.throwIfAborted();
      const client = getOpenAIClient({ apiKey, correlationId: usageScope?.correlationId });
      const request: BoundedWebSearchRequest = {
          model: runtimeModel.model,
          store: false,
          instructions: [
            "You are Asael live web search.",
            `The trusted current UTC timestamp is ${searchedAt}.`,
            "Search the public web for this request, compare credible sources, and summarize only source-supported facts.",
            "Return a compact research brief with source titles and URLs. If sources disagree, call that out.",
          ].join("\n"),
          input: [
            `Search query: ${normalizedQuery}`,
            "",
            "Output format:",
            "1. Short answer",
            "2. Key facts",
            "3. Sources with title and URL",
          ].join("\n"),
          tools: [
            {
              type: "web_search",
              search_context_size: contextSize,
              // Preserve the caller's source boundary. Unsupported model routes
              // must fail rather than retry with an unrestricted search.
              ...(allowedDomains?.length
                ? { filters: { allowed_domains: allowedDomains } }
                : {}),
            },
          ],
          // This is the only declared tool, so required forces a real search.
          tool_choice: "required",
          max_tool_calls: 3,
          max_output_tokens: 2_000,
          include: ["web_search_call.results", "web_search_call.action.sources"],
      };
      dispatched = true;
      return client.responses.create(
        request,
        { signal: combinedSignal, maxRetries: 0, timeout: WEB_SEARCH_TIMEOUT_MS },
      );
    });
    const searchCalls = hostedWebSearchCalls(response);
    // The usage ledger's legacy query counter records hosted invocations,
    // not the number of URLs or query strings inside one invocation.
    searchCallCount = searchCalls.length;
    const usage = openAIResponseUsage(response.usage);
    const estimatedCostUsd = response.usage
      ? estimateWebSearchCostUsd(runtimeModel.model, usage, searchCallCount)
      : undefined;
    const sources = extractWebSources(response).slice(0, Math.min(Math.max(maxSources, 1), 20));
    const summary = response.output_text?.trim() || "";
    const searchFailure = searchCalls.some((call) => call.status !== "completed")
      ? "Live web search did not complete its search calls."
      : !searchCalls.some((call) => call.action.type === "search")
        ? "Live web search returned no completed search call."
        : !summary
          ? "Live web search returned no answer."
          : !sources.length
            ? "Live web search returned no usable source URLs."
            : undefined;
    const responseFailure = classifyOpenAITerminalResponse(response) || (
      searchFailure
        ? new ModelProviderError(searchFailure, "openai", "unavailable", true)
        : undefined
    );
    if (responseFailure) {
      throw attachModelProviderResponseReceipt(responseFailure, {
        usage,
        latencyMs: Date.now() - startedAt,
        model: runtimeModel.model,
        estimatedCostUsd,
        providerRequestId: response.id,
      });
    }
    if (meteredUsageScope) {
      await recordAiUsageSafely({
        ...meteredUsageScope,
        status: "completed",
        provider: "openai",
        model: runtimeModel.model,
        usage: { ...usage, searchQueryCount: searchCallCount },
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: 0,
        latencyMs: Date.now() - startedAt,
        estimatedCostUsd,
        providerRequestId: response.id,
      });
    }
    return {
      query: normalizedQuery,
      searchedAt,
      provider: "openai.responses.web_search",
      model: runtimeModel.model,
      summary,
      sources,
      sourceCount: sources.length,
    };
  } catch (caught) {
    const error = allowedDomains?.length && isRejectedDomainFilterError(caught)
      ? new ModelProviderError(
          "The web search provider rejected the requested domain filters. Check the domains and selected Web search model in Settings; the search was not retried without filters.",
          "openai",
          "invalid_request",
          false,
          400,
        )
      : caught;
    const responseReceipt = getModelProviderResponseReceipt(error);
    const providerFailure = error instanceof ModelProviderError ? error : undefined;
    if (meteredUsageScope) {
      await recordAiUsageSafely({
        ...meteredUsageScope,
        status: "failed",
        provider: "openai",
        model: runtimeModel.model,
        usage: {
          ...(responseReceipt?.usage || {}),
          searchQueryCount: searchCallCount,
        },
        providerCallCount: dispatched ? 1 : 0,
        attemptCount: dispatched ? 1 : 0,
        failedAttemptCount: dispatched ? 1 : 0,
        latencyMs: Date.now() - startedAt,
        estimatedCostUsd: responseReceipt?.estimatedCostUsd,
        providerRequestId: responseReceipt?.providerRequestId,
        failureKind: timeoutController.signal.aborted
          ? "timeout"
          : combinedSignal.aborted
            ? "abort"
            : providerFailure?.kind || "provider_error",
        retryable: combinedSignal.aborted
          ? false
          : providerFailure?.retryable ?? true,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function hostedWebSearchCalls(response: Pick<Response, "output">) {
  return response.output.filter((item): item is ResponseFunctionWebSearch =>
    item.type === "web_search_call"
  );
}

function isRejectedDomainFilterError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; param?: unknown; message?: unknown };
  return value.status === 400 && (
    /filters|allowed_domains/.test(stringValue(value.param)) ||
    /(?:filters|allowed_domains).*(?:unsupported|not supported)|(?:unsupported|not supported).*filters/i.test(stringValue(value.message))
  );
}

// Cap how much web evidence is injected into the agent prompt. The production
// OpenAI tier is TPM-throttled, so a large prompt makes output stream very slowly
// and can overrun the function budget. Keep the brief and snippets compact.
const MAX_SUMMARY_CHARS = 1_200;
const MAX_SNIPPET_CHARS = 200;

export function formatLiveWebSearchContext(result: LiveWebSearchResult) {
  const sources = result.sources.length
    ? result.sources
      .map((source) => {
        const snippet = source.snippet ? source.snippet.slice(0, MAX_SNIPPET_CHARS) : "";
        return `[${source.citationId}] ${source.title || source.url} - ${source.url}${snippet ? `\n    ${snippet}` : ""}`;
      })
      .join("\n")
    : "No structured source URLs were returned. Use the live web brief cautiously and say that source extraction was incomplete.";

  const summary = result.summary.length > MAX_SUMMARY_CHARS
    ? `${result.summary.slice(0, MAX_SUMMARY_CHARS)}… [truncated]`
    : result.summary;

  return [
    "Live web search evidence:",
    `Searched at: ${result.searchedAt}`,
    `Provider: ${result.provider}`,
    `Query: ${result.query}`,
    "",
    "Brief:",
    summary,
    "",
    "Sources:",
    sources,
  ].join("\n");
}

type CollectedWebSource = { source: LiveWebSearchSource; cited: boolean };

function extractWebSources(response: { output: unknown }) {
  const sources = new Map<string, CollectedWebSource>();

  collectWebSources(response.output, sources);
  // The full retrieved URL list can be much longer than the answer's citations.
  // Keep those citations first when the caller limits the returned evidence.
  return [...sources.values()]
    .sort((left, right) => Number(right.cited) - Number(left.cited))
    .map((item) => item.source);
}

function collectWebSources(value: unknown, sources: Map<string, CollectedWebSource>) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWebSources(item, sources);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const type = stringValue(record.type);
  const url = stringValue(record.url);
  if (url && (type.includes("citation") || type === "url" || type === "source" || looksLikeWebSearchRecord(record))) {
    const snippet = stringValue(record.snippet || record.text || record.content);
    addSource({
      title: stringValue(record.title || record.name, url),
      url,
      snippet: snippet || undefined,
    }, sources, type.includes("citation"));
  }

  for (const child of Object.values(record)) {
    collectWebSources(child, sources);
  }
}

function addSource(
  source: Omit<LiveWebSearchSource, "citationId">,
  sources: Map<string, CollectedWebSource>,
  cited: boolean,
) {
  const citationId = citationIdForWebUrl(source.url);
  if (!citationId) return;
  const normalizedUrl = new URL(source.url.trim());
  normalizedUrl.username = "";
  normalizedUrl.password = "";
  normalizedUrl.hash = "";
  const url = normalizedUrl.toString();
  const title = source.title.trim() && source.title !== source.url
    ? source.title.trim().slice(0, 1_000)
    : url;
  const snippet = source.snippet?.trim().slice(0, 2_000) || undefined;
  const existing = sources.get(citationId);
  if (existing) {
    if (title !== url && (existing.source.title === url || (cited && !existing.cited))) {
      existing.source.title = title;
    }
    existing.source.snippet ||= snippet;
    existing.cited ||= cited;
    return;
  }
  sources.set(citationId, { source: { citationId, title, url, snippet }, cited });
}

function looksLikeWebSearchRecord(record: Record<string, unknown>) {
  return Boolean(
    record.url &&
      (
        record.title ||
        record.snippet ||
        record.source ||
        record.annotations ||
        stringValue(record.type).includes("web_search")
      ),
  );
}

function stringValue(value: unknown, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}
