import { WEB_SEARCH_MODEL, WEB_SEARCH_TIMEOUT_MS, hasOpenAIKey } from "@/lib/config";
import { getOpenAIClient } from "@/lib/openai/client";
import { citationIdForWebUrl } from "@/lib/rag/citations";

export type LiveWebSearchContextSize = "low" | "medium" | "high";

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

const freshnessPattern = /\b(today|tonight|yesterday|tomorrow|now|current|currently|latest|newest|recent|recently|breaking|live|real[-\s]?time|up[-\s]?to[-\s]?date|as of|this week|this month|this year|released|launch(?:ed)?|announc(?:ed|ement)|price|pricing|stock|market|weather|score|schedule|deadline|version|changelog|news|web search|search (?:the )?web|browse|look up|verify|multiple sources|sources|citations?)\b/i;
const noWebPattern = /\b(do not|don't|dont|without|no)\s+(?:use\s+)?(?:the\s+)?(?:web|internet|browser|search|live search|(?:any\s+)?external tools?|any tools?)\b|\bfrom memory only\b|\boffline\b/i;

/** The gpt-4o family does not accept the `filters` param on the hosted web_search tool. */
function supportsWebSearchFilters(model: string) {
  return !/^gpt-4o/i.test(model);
}

export function shouldUseLiveWebSearch(query: string) {
  const normalized = query.trim();
  if (!normalized || noWebPattern.test(normalized)) {
    return false;
  }

  return freshnessPattern.test(normalized);
}

export async function runLiveWebSearch({
  query,
  contextSize = "medium",
  allowedDomains,
  maxSources = 8,
  abortSignal,
}: {
  query: string;
  contextSize?: LiveWebSearchContextSize;
  allowedDomains?: string[];
  maxSources?: number;
  abortSignal?: AbortSignal;
}): Promise<LiveWebSearchResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("Live web search query is required.");
  }
  if (!hasOpenAIKey()) {
    throw new Error("OPENAI_API_KEY is required for live web search.");
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error(`Web search timed out after ${WEB_SEARCH_TIMEOUT_MS}ms`)), WEB_SEARCH_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any
    ? AbortSignal.any([timeoutController.signal, ...(abortSignal ? [abortSignal] : [])])
    : timeoutController.signal;

  let response;
  try {
    response = await getOpenAIClient().responses.create(
      {
        model: WEB_SEARCH_MODEL,
        store: false,
        instructions: [
          "You are Asael live web search.",
          "Search the public web when needed, compare multiple credible sources, and summarize only source-supported facts.",
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
            // The gpt-4o family rejects the `filters` param on the hosted web_search
            // tool; only attach domain filtering for models that support it.
            ...(allowedDomains?.length && supportsWebSearchFilters(WEB_SEARCH_MODEL)
              ? { filters: { allowed_domains: allowedDomains } }
              : {}),
          },
        ],
        include: ["web_search_call.results", "web_search_call.action.sources"],
      },
      { signal: combinedSignal },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const sources = extractWebSources(response).slice(0, Math.min(Math.max(maxSources, 1), 20));

  return {
    query: normalizedQuery,
    searchedAt: new Date().toISOString(),
    provider: "openai.responses.web_search",
    model: WEB_SEARCH_MODEL,
    summary: response.output_text || "Live web search completed, but no summary text was returned.",
    sources,
    sourceCount: sources.length,
  };
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

function extractWebSources(response: unknown) {
  const sources: LiveWebSearchSource[] = [];
  const seen = new Set<string>();

  collectWebSources(response, sources, seen);
  return sources;
}

function collectWebSources(value: unknown, sources: LiveWebSearchSource[], seen: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWebSources(item, sources, seen);
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
    }, sources, seen);
  }

  for (const child of Object.values(record)) {
    collectWebSources(child, sources, seen);
  }
}

function addSource(
  source: Omit<LiveWebSearchSource, "citationId">,
  sources: LiveWebSearchSource[],
  seen: Set<string>,
) {
  const citationId = citationIdForWebUrl(source.url);
  if (!citationId || seen.has(citationId)) return;
  seen.add(citationId);
  sources.push({ ...source, citationId });
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
