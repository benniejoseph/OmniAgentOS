import {
  A2A_MEDIA_TYPE,
  A2A_PROTOCOL_VERSION,
  a2aSendMessageRequestV1Schema,
  a2aTaskV1Schema,
  externalA2AAgentCardV1Schema,
  parseA2ATaskV1,
  type A2AMessageV1,
  type A2ATaskV1,
  type ExternalA2AAgentCardV1,
} from "@/lib/a2a/v1-contracts";
import {
  assertA2APeerRolloutActive,
  parseA2APeerRolloutV1,
  type A2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import { assertPublicHttpUrl, fetchPublicHttpUrl } from "@/lib/security/network";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const DISCOVERY_MAX_BYTES = 256_000;
const RESPONSE_MAX_BYTES = 2_000_000;
const STREAM_EVENT_MAX_BYTES = 262_144;
const STREAM_TOTAL_MAX_BYTES = 2_000_000;
const DEFAULT_DEADLINE_MS = 45_000;

export type DiscoveredA2APeerV1 = Readonly<{
  card: ExternalA2AAgentCardV1;
  cardSha256: string;
  selectedInterface: ExternalA2AAgentCardV1["supportedInterfaces"][number];
}>;

export async function discoverExternalA2APeerV1(input: {
  baseUrl: string;
  abortSignal?: AbortSignal;
}) {
  const origin = new URL(await assertPublicHttpUrl(input.baseUrl, "A2A peer URL"));
  const cardUrl = new URL("/.well-known/agent-card.json", origin).toString();
  const response = await fetchPublicHttpUrl(cardUrl, {
    method: "GET",
    headers: { Accept: `${A2A_MEDIA_TYPE}, application/json` },
    redirect: "manual",
    signal: deadlineSignal(input.abortSignal),
  }, "A2A Agent Card URL");
  assertSafeResponse(response, "A2A Agent Card");
  const card = externalA2AAgentCardV1Schema.parse(
    await readBoundedJson(response, DISCOVERY_MAX_BYTES, "A2A Agent Card"),
  );
  const selectedInterface = card.supportedInterfaces.find((candidate) =>
    candidate.protocolBinding === "HTTP+JSON" &&
    candidate.protocolVersion === A2A_PROTOCOL_VERSION
  );
  if (!selectedInterface) {
    throw new Error("The A2A peer does not advertise a compatible HTTP+JSON 1.0 interface.");
  }
  await assertPublicHttpUrl(selectedInterface.url, "A2A peer interface");
  return deepFreeze({
    card,
    cardSha256: canonicalJsonSha256(card),
    selectedInterface,
  });
}

export function createA2AClientV1(input: {
  rollout: A2APeerRolloutV1;
  bearerToken: string;
}) {
  const rollout = assertA2APeerRolloutActive({
    rollout: parseA2APeerRolloutV1(input.rollout),
    direction: "outbound",
  });
  const bearerToken = validBearerToken(input.bearerToken);
  const interfaceUrl = new URL(rollout.interfaceUrl);
  const request = async (
    relativePath: string,
    init: RequestInit,
    label: string,
  ) => {
    const target = new URL(`./${relativePath.replace(/^\/+/, "")}`, interfaceUrl);
    if (target.origin !== interfaceUrl.origin) {
      throw new Error("A2A requests cannot leave the pinned peer origin.");
    }
    const response = await fetchPublicHttpUrl(target, {
      ...init,
      headers: {
        Accept: `${A2A_MEDIA_TYPE}, application/json`,
        Authorization: `Bearer ${bearerToken}`,
        "A2A-Version": A2A_PROTOCOL_VERSION,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
      redirect: "manual",
      signal: deadlineSignal(init.signal || undefined, rollout.maxTaskDurationMs),
    }, label);
    assertSafeResponse(response, label);
    return response;
  };

  return Object.freeze({
    async sendMessage(message: A2AMessageV1, options: {
      acceptedOutputModes?: readonly string[];
      blocking?: boolean;
      abortSignal?: AbortSignal;
    } = {}) {
      const body = a2aSendMessageRequestV1Schema.parse({
        message,
        configuration: {
          acceptedOutputModes: options.acceptedOutputModes || [
            "text/plain",
            "application/json",
          ],
          blocking: options.blocking ?? false,
        },
      });
      assertRequestBytes(body, rollout.maxInputBytes);
      const response = await request("message:send", {
        method: "POST",
        headers: {
          "Content-Type": A2A_MEDIA_TYPE,
          "Idempotency-Key": message.messageId,
        },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      }, "A2A send message");
      return parseTaskResponse(response, rollout.maxOutputBytes);
    },

    async getTask(taskId: string, options: {
      historyLength?: number;
      abortSignal?: AbortSignal;
    } = {}) {
      const query = new URLSearchParams();
      if (options.historyLength !== undefined) {
        if (!Number.isInteger(options.historyLength) || options.historyLength < 0 || options.historyLength > 50) {
          throw new Error("A2A task historyLength must be between 0 and 50.");
        }
        query.set("historyLength", String(options.historyLength));
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      const response = await request(
        `tasks/${encodeURIComponent(validId(taskId))}${suffix}`,
        { method: "GET", signal: options.abortSignal },
        "A2A get task",
      );
      return parseTaskResponse(response, rollout.maxOutputBytes);
    },

    async cancelTask(taskId: string, abortSignal?: AbortSignal) {
      const response = await request(
        `tasks/${encodeURIComponent(validId(taskId))}:cancel`,
        { method: "POST", signal: abortSignal },
        "A2A cancel task",
      );
      return parseTaskResponse(response, rollout.maxOutputBytes);
    },

    async *subscribeToTask(taskId: string, abortSignal?: AbortSignal) {
      const response = await request(
        `tasks/${encodeURIComponent(validId(taskId))}:subscribe`,
        {
          method: "POST",
          headers: { Accept: "text/event-stream" },
          signal: abortSignal,
        },
        "A2A subscribe task",
      );
      assertEventStream(response);
      for await (const value of readA2AEventStream(response)) {
        yield parseStreamResponse(value);
      }
    },
  });
}

async function parseTaskResponse(response: Response, maxBytes: number) {
  const body = await readBoundedJson(
    response,
    Math.min(maxBytes, RESPONSE_MAX_BYTES),
    "A2A task response",
  );
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The A2A task response is invalid.");
  }
  const record = body as Record<string, unknown>;
  return parseA2ATaskV1(record.task || body);
}

function parseStreamResponse(value: unknown): Readonly<
  | { type: "task"; task: A2ATaskV1 }
  | { type: "status"; statusUpdate: Record<string, unknown> }
  | { type: "artifact"; artifactUpdate: Record<string, unknown> }
  | { type: "message"; message: A2AMessageV1 }
> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The A2A stream response is invalid.");
  }
  const record = value as Record<string, unknown>;
  const fields = ["task", "statusUpdate", "artifactUpdate", "message"].filter(
    (field) => record[field] !== undefined,
  );
  if (fields.length !== 1) {
    throw new Error("An A2A stream response must contain exactly one event.");
  }
  if (record.task) return deepFreeze({ type: "task" as const, task: parseA2ATaskV1(record.task) });
  if (record.message) {
    const message = a2aSendMessageRequestV1Schema.shape.message.parse(record.message);
    return deepFreeze({ type: "message" as const, message });
  }
  if (record.statusUpdate) {
    const update = statusUpdate(record.statusUpdate);
    return deepFreeze({ type: "status" as const, statusUpdate: update });
  }
  return deepFreeze({
    type: "artifact" as const,
    artifactUpdate: artifactUpdate(record.artifactUpdate),
  });
}

function statusUpdate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid A2A status update.");
  const record = value as Record<string, unknown>;
  const parsedTask = a2aTaskV1Schema.parse({
    id: record.taskId,
    contextId: record.contextId,
    status: record.status,
  });
  return {
    taskId: parsedTask.id,
    contextId: parsedTask.contextId,
    status: parsedTask.status,
  };
}

function artifactUpdate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid A2A artifact update.");
  const record = value as Record<string, unknown>;
  const taskId = validId(record.taskId);
  const contextId = validId(record.contextId);
  const task = a2aTaskV1Schema.parse({
    id: taskId,
    contextId,
    status: { state: "TASK_STATE_WORKING" },
    artifacts: [record.artifact],
  });
  return {
    taskId,
    contextId,
    artifact: task.artifacts![0],
    append: record.append === true,
    lastChunk: record.lastChunk === true,
  };
}

async function* readA2AEventStream(response: Response) {
  if (!response.body) throw new Error("The A2A stream has no response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > STREAM_TOTAL_MAX_BYTES) throw new Error("The A2A stream exceeded its total byte boundary.");
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary).replaceAll("\r", "");
        buffer = buffer.slice(boundary + 2);
        const data = event.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (Buffer.byteLength(data, "utf8") > STREAM_EVENT_MAX_BYTES) {
          throw new Error("An A2A stream event exceeded its byte boundary.");
        }
        if (data) yield JSON.parse(data) as unknown;
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) throw new Error("The A2A stream ended with an incomplete event.");
  } finally {
    reader.releaseLock();
  }
}

function assertSafeResponse(response: Response, label: string) {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${label} redirects are not allowed.`);
  }
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
}

function assertEventStream(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("text/event-stream")) {
    throw new Error("The A2A subscription did not return an event stream.");
  }
}

async function readBoundedJson(response: Response, maxBytes: number, label: string) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label} exceeds its byte boundary.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds its byte boundary.`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function assertRequestBytes(value: unknown, maxBytes: number) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
    throw new Error("The A2A request exceeds the peer rollout input boundary.");
  }
}

function validBearerToken(value: string) {
  const token = value.trim();
  if (!token || token.length > 8_192 || /[\r\n\s]/.test(token)) {
    throw new Error("A valid endpoint-bound A2A Bearer token is required.");
  }
  return token;
}

function validId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(value)) {
    throw new Error("The A2A task identifier is invalid.");
  }
  return value;
}

function deadlineSignal(signal?: AbortSignal, timeoutMs = DEFAULT_DEADLINE_MS) {
  if (!signal) return AbortSignal.timeout(timeoutMs);
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
