export const MAX_JSON_BODY_BYTES = 1_000_000;

export type LimitedTextBody = {
  text: string;
  bytesRead: number;
  truncated: boolean;
};

export class JsonBodyError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 | 415 = 400,
  ) {
    super(message);
    this.name = "JsonBodyError";
  }
}

export function parseBoundedInteger(
  value: string | null | undefined,
  fallback: number,
  {
    min = 1,
    max,
  }: {
    min?: number;
    max: number;
  },
) {
  const parsed = value === null || value === undefined || value.trim() === ""
    ? fallback
    : Number(value);
  const candidate = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(Math.max(candidate, min), max);
}

export async function parseJsonBody(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const boundedMax = normalizeMaxBytes(maxBytes);
  if (request.body && !isJsonContentType(request.headers.get("content-type"))) {
    throw new JsonBodyError(
      "JSON requests must use an application/json content type.",
      415,
    );
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > boundedMax) {
    throw new JsonBodyError("Request body is too large.", 413);
  }

  const body = await readStreamTextLimited(request.body, boundedMax);
  if (body.truncated) {
    throw new JsonBodyError("Request body is too large.", 413);
  }
  const raw = body.text;
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new JsonBodyError("Request body is not valid JSON.");
  }
}

export function jsonBodyErrorResponse(error: unknown) {
  if (error instanceof JsonBodyError) {
    return Response.json(
      {
        error:
          error.status === 413
            ? "Payload Too Large"
            : error.status === 415
              ? "Unsupported Media Type"
              : "Invalid request",
        message: error.message,
      },
      { status: error.status },
    );
  }

  throw error;
}

function isJsonContentType(value: string | null) {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

export async function readRequestTextLimited(
  request: Request,
  maxBytes: number,
): Promise<LimitedTextBody> {
  const boundedMax = normalizeMaxBytes(maxBytes);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  const body = await readStreamTextLimited(request.body, boundedMax);
  return {
    ...body,
    truncated: body.truncated || (Number.isFinite(declaredLength) && declaredLength > boundedMax),
  };
}

/**
 * Read at most maxBytes from a response without first buffering the full body.
 * The stream is canceled as soon as the bound is reached.
 */
export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<LimitedTextBody> {
  const boundedMax = normalizeMaxBytes(maxBytes);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  const body = await readStreamTextLimited(response.body, boundedMax);
  return {
    ...body,
    truncated: body.truncated || (Number.isFinite(declaredLength) && declaredLength > boundedMax),
  };
}

async function readStreamTextLimited(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<LimitedTextBody> {
  const boundedMax = normalizeMaxBytes(maxBytes);
  if (!stream) {
    return { text: "", bytesRead: 0, truncated: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.byteLength) {
        continue;
      }

      const remaining = boundedMax - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel("Body byte limit reached.").catch(() => undefined);
        break;
      }

      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        bytesRead += remaining;
        truncated = true;
        await reader.cancel("Body byte limit reached.").catch(() => undefined);
        break;
      }

      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder().decode(bytes),
    bytesRead,
    truncated,
  };
}

function normalizeMaxBytes(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Body byte limit must be a positive safe integer.");
  }
  return value;
}
