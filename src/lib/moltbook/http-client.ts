import "server-only";

import { createHash } from "node:crypto";

import {
  MOLTBOOK_API_BASE,
  MOLTBOOK_API_ORIGIN,
  type MoltbookRateLimitProjection,
  type MoltbookToolId,
} from "@/lib/moltbook/contracts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 512 * 1_024;
const MAX_PROVIDER_STRING = 8_000;
const MAX_PROVIDER_ARRAY = 100;
const MAX_PROVIDER_KEYS = 100;
const MAX_PROVIDER_DEPTH = 8;

type FetchLike = typeof fetch;

class MoltbookResponseLimitError extends Error {}

export type MoltbookHttpResult<T = unknown> = Readonly<{
  data: T;
  requestSha256: string;
  responseSha256: string;
  statusCode: number;
  rateLimit?: MoltbookRateLimitProjection;
}>;

export type MoltbookRegistration = Readonly<{
  apiKey: string;
  claimUrl: string;
  verificationCode: string;
}>;

export function moltbookMutationRequestSha256(
  toolId: MoltbookToolId,
  toolInput: Record<string, unknown>,
) {
  const request = moltbookMutationRequest(toolId, toolInput);
  return requestSha256For(request.method, request.path, request.body);
}

export class MoltbookProviderError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly requestSha256?: string;
  readonly responseSha256?: string;
  readonly rateLimit?: MoltbookRateLimitProjection;

  constructor(input: {
    message: string;
    code: string;
    statusCode?: number;
    requestSha256?: string;
    responseSha256?: string;
    rateLimit?: MoltbookRateLimitProjection;
  }) {
    super(input.message);
    this.name = "MoltbookProviderError";
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.requestSha256 = input.requestSha256;
    this.responseSha256 = input.responseSha256;
    this.rateLimit = input.rateLimit;
  }
}

export async function registerMoltbookAgent(
  input: { name: string; description: string },
  options: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  } = {},
): Promise<MoltbookHttpResult<MoltbookRegistration>> {
  const response = await moltbookRequest({
    method: "POST",
    path: "/agents/register",
    body: { name: input.name, description: input.description },
    ...options,
  });
  const agent = providerRecord(providerRecord(response.data).agent);
  const apiKey = boundedString(agent.api_key, 16, 1_000);
  const claimUrl = boundedString(agent.claim_url, 12, 2_048);
  const verificationCode = boundedString(agent.verification_code, 3, 240);
  if (!isOpaqueMoltbookApiKey(apiKey)) {
    throw invalidRegistration(response, "Moltbook returned an invalid agent credential.");
  }
  if (!isExactClaimUrl(claimUrl)) {
    throw invalidRegistration(response, "Moltbook returned an invalid claim link.");
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(verificationCode)) {
    throw invalidRegistration(response, "Moltbook returned an invalid verification code.");
  }
  return {
    ...response,
    data: { apiKey, claimUrl, verificationCode },
  };
}

export function createMoltbookClient(
  input: {
    apiKey: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  },
) {
  const apiKey = input.apiKey.trim();
  if (!isOpaqueMoltbookApiKey(apiKey)) {
    throw new MoltbookProviderError({
      code: "credential_invalid",
      message: "The Moltbook credential is unavailable or invalid.",
    });
  }
  const request = (
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ) => moltbookRequest({
    method,
    path,
    body,
    apiKey,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    abortSignal: input.abortSignal,
  });
  const mutation = (
    toolId: MoltbookToolId,
    toolInput: Record<string, unknown>,
  ) => {
    const operation = moltbookMutationRequest(toolId, toolInput);
    return request(operation.method, operation.path, operation.body);
  };

  return Object.freeze({
    status: () => request("GET", "/agents/status"),
    home: () => request("GET", "/home"),
    feed: (options: {
      sort: "new" | "hot" | "top";
      limit: number;
      filter?: "following";
    }) => request("GET", withQuery("/feed", options)),
    thread: async (options: {
      postId: string;
      sort: "best" | "new" | "old";
      limit: number;
    }) => {
      const postPath = `/posts/${encodeURIComponent(options.postId)}`;
      const post = await request("GET", postPath);
      const comments = await request("GET", withQuery(`${postPath}/comments`, {
        sort: options.sort,
        limit: options.limit,
      }));
      const postEnvelope = providerRecord(post.data);
      const commentsEnvelope = providerRecord(comments.data);
      return {
        data: {
          post: postEnvelope.post || post.data,
          comments: commentsEnvelope.comments || comments.data,
        },
        requestSha256: sha256(`${post.requestSha256}\0${comments.requestSha256}`),
        responseSha256: sha256(`${post.responseSha256}\0${comments.responseSha256}`),
        statusCode: comments.statusCode,
        rateLimit: comments.rateLimit || post.rateLimit,
      } satisfies MoltbookHttpResult;
    },
    createPost: (post: {
      submoltName: string;
      title: string;
      content?: string;
      url?: string;
      type?: "text" | "link" | "image";
    }) => mutation("moltbook.post.create", post),
    createComment: (comment: {
      postId: string;
      content: string;
      parentId?: string;
    }) => mutation("moltbook.comment.create", comment),
    votePost: (postId: string, direction: "up" | "down") =>
      mutation("moltbook.post.vote", { postId, direction }),
    upvoteComment: (commentId: string) =>
      mutation("moltbook.comment.upvote", { commentId }),
    followAgent: (name: string, follow: boolean) =>
      mutation("moltbook.agent.follow", { name, follow }),
    verify: (verificationCode: string, answer: string) =>
      mutation("moltbook.verify", { verificationCode, answer }),
  });
}

async function moltbookRequest(input: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<MoltbookHttpResult> {
  const url = exactApiUrl(input.path);
  const bodyText = input.body === undefined ? undefined : JSON.stringify(input.body);
  const requestSha256 = requestSha256For(input.method, input.path, input.body);
  const timeoutMs = Math.min(
    Math.max(Math.trunc(input.timeoutMs || DEFAULT_TIMEOUT_MS), 1_000),
    MAX_TIMEOUT_MS,
  );
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const headers: Record<string, string> = { accept: "application/json" };
  if (bodyText !== undefined) headers["content-type"] = "application/json";
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;

  let response: Response;
  try {
    response = await (input.fetchImpl || fetch)(url, {
      method: input.method,
      headers,
      body: bodyText,
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } catch {
    const timedOut = timeoutController.signal.aborted && !input.abortSignal?.aborted;
    throw new MoltbookProviderError({
      code: timedOut ? "provider_timeout" : "provider_unavailable",
      message: timedOut
        ? "Moltbook did not respond before the bounded timeout."
        : "Moltbook could not be reached safely.",
      requestSha256,
    });
  } finally {
    clearTimeout(timeout);
  }

  const rateLimit = rateLimitProjection(response.headers);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new MoltbookProviderError({
      code: "provider_response_too_large",
      message: "Moltbook returned more data than this operation accepts.",
      statusCode: response.status,
      requestSha256,
      rateLimit,
    });
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponseBytes(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof MoltbookResponseLimitError) {
      throw new MoltbookProviderError({
        code: "provider_response_too_large",
        message: "Moltbook returned more data than this operation accepts.",
        statusCode: response.status,
        requestSha256,
        rateLimit,
      });
    }
    throw new MoltbookProviderError({
      code: "provider_response_unavailable",
      message: "Moltbook response data could not be read safely.",
      statusCode: response.status,
      requestSha256,
      rateLimit,
    });
  }
  const responseSha256 = sha256(bytes);
  if (!response.ok) {
    throw new MoltbookProviderError({
      code: providerHttpCode(response.status),
      message: `Moltbook rejected the request (${response.status}).`,
      statusCode: response.status,
      requestSha256,
      responseSha256,
      rateLimit,
    });
  }
  let parsed: unknown;
  try {
    parsed = bytes.byteLength
      ? JSON.parse(new TextDecoder().decode(bytes)) as unknown
      : {};
  } catch {
    throw new MoltbookProviderError({
      code: "provider_response_invalid",
      message: "Moltbook returned an invalid response.",
      statusCode: response.status,
      requestSha256,
      responseSha256,
      rateLimit,
    });
  }
  return {
    data: boundProviderValue(parsed),
    requestSha256,
    responseSha256,
    statusCode: response.status,
    rateLimit,
  };
}

function moltbookMutationRequest(
  toolId: MoltbookToolId,
  input: Record<string, unknown>,
): Readonly<{
  method: "POST" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}> {
  switch (toolId) {
    case "moltbook.post.create":
      return {
        method: "POST",
        path: "/posts",
        body: compactObject({
          submolt_name: input.submoltName,
          title: input.title,
          content: input.content,
          url: input.url,
          type: input.type,
        }),
      };
    case "moltbook.comment.create":
      return {
        method: "POST",
        path: `/posts/${encodeURIComponent(String(input.postId))}/comments`,
        body: compactObject({
          content: input.content,
          parent_id: input.parentId,
        }),
      };
    case "moltbook.post.vote":
      return {
        method: "POST",
        path: `/posts/${encodeURIComponent(String(input.postId))}/${input.direction === "up" ? "upvote" : "downvote"}`,
      };
    case "moltbook.comment.upvote":
      return {
        method: "POST",
        path: `/comments/${encodeURIComponent(String(input.commentId))}/upvote`,
      };
    case "moltbook.agent.follow":
      return {
        method: input.follow === true ? "POST" : "DELETE",
        path: `/agents/${encodeURIComponent(String(input.name))}/follow`,
      };
    case "moltbook.verify":
      return {
        method: "POST",
        path: "/verify",
        body: {
          verification_code: input.verificationCode,
          answer: input.answer,
        },
      };
    default:
      throw new MoltbookProviderError({
        code: "provider_operation_invalid",
        message: "The Moltbook operation does not have a public mutation request.",
      });
  }
}

function requestSha256For(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
) {
  const url = exactApiUrl(path);
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  return sha256([
    method,
    url.pathname + url.search,
    bodyText || "",
  ].join("\n"));
}

async function readBoundedResponseBytes(response: Response, maximumBytes: number) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("bounded Moltbook response exceeded").catch(() => undefined);
        throw new MoltbookResponseLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function exactApiUrl(path: string) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new MoltbookProviderError({
      code: "provider_path_invalid",
      message: "The Moltbook operation path is invalid.",
    });
  }
  const url = new URL(`${MOLTBOOK_API_BASE}${path}`);
  if (
    url.protocol !== "https:" ||
    url.origin !== MOLTBOOK_API_ORIGIN ||
    !url.pathname.startsWith("/api/v1/") ||
    url.username ||
    url.password
  ) {
    throw new MoltbookProviderError({
      code: "provider_host_invalid",
      message: "The Moltbook operation host is invalid.",
    });
  }
  return url;
}

function withQuery(
  path: string,
  values: Record<string, string | number | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return `${path}?${query.toString()}`;
}

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function boundProviderValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_PROVIDER_DEPTH) return "[provider data truncated]";
  if (typeof value === "string") return value.slice(0, MAX_PROVIDER_STRING);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_PROVIDER_ARRAY)
      .map((item) => boundProviderValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_PROVIDER_KEYS)
        .map(([key, item]) => [
          key.slice(0, 120),
          boundProviderValue(item, depth + 1),
        ]),
    );
  }
  return String(value).slice(0, MAX_PROVIDER_STRING);
}

function rateLimitProjection(headers: Headers): MoltbookRateLimitProjection | undefined {
  const limit = safeNonNegativeInteger(headers.get("x-ratelimit-limit"));
  const remaining = safeNonNegativeInteger(headers.get("x-ratelimit-remaining"));
  const retryAfterSeconds = safeNonNegativeInteger(headers.get("retry-after"));
  const resetAt = safeResetAt(headers.get("x-ratelimit-reset"));
  if (
    limit === undefined &&
    remaining === undefined &&
    retryAfterSeconds === undefined &&
    resetAt === undefined
  ) return undefined;
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    observedAt: new Date().toISOString(),
  };
}

function safeNonNegativeInteger(value: string | null) {
  if (!value || !/^[0-9]{1,12}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function safeResetAt(value: string | null) {
  if (!value) return undefined;
  if (/^[0-9]{10,13}$/.test(value)) {
    const raw = Number(value);
    const millis = value.length === 10 ? raw * 1_000 : raw;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function providerHttpCode(status: number) {
  if (status === 401 || status === 403) return "provider_auth_rejected";
  if (status === 404) return "provider_not_found";
  if (status === 409) return "provider_conflict";
  if (status === 410) return "provider_expired";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_request_rejected";
}

function providerRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedString(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "string") return "";
  const bounded = value.trim().slice(0, maximum);
  return bounded.length >= minimum ? bounded : "";
}

export function isOpaqueMoltbookApiKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 1_000 &&
    /^[\x21-\x7e]+$/.test(value);
}

function isExactClaimUrl(value: string) {
  try {
    const url = new URL(value);
    return url.origin === MOLTBOOK_API_ORIGIN &&
      /^\/claim\/[A-Za-z0-9_.:-]+$/.test(url.pathname) &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function invalidRegistration(
  response: MoltbookHttpResult,
  message: string,
) {
  return new MoltbookProviderError({
    code: "provider_registration_invalid",
    message,
    statusCode: response.statusCode,
    requestSha256: response.requestSha256,
    responseSha256: response.responseSha256,
    rateLimit: response.rateLimit,
  });
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
