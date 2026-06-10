const MAX_JSON_BODY_BYTES = 1_000_000;

export class JsonBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonBodyError";
  }
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_JSON_BODY_BYTES) {
    throw new JsonBodyError("Request body is too large.");
  }

  const raw = await request.text();
  if (raw.length > MAX_JSON_BODY_BYTES) {
    throw new JsonBodyError("Request body is too large.");
  }
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
    return Response.json({ error: "Invalid request", message: error.message }, { status: 400 });
  }

  throw error;
}
