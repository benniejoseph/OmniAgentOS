export class StudioResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}
export class StudioScopeChanged extends Error {
  constructor() {
    super("Workspace access changed. Reopen the studio to continue.");
  }
}
export class StudioRequestTimeout extends Error {
  constructor() {
    super(
      "The request timed out. Your work is retained. Retry the same action to recover its result.",
    );
  }
}

async function mutationIdentity(
  path: string,
  method: string,
  body: BodyInit | null | undefined,
) {
  let payload = typeof body === "string" ? body : "";
  if (body instanceof FormData) {
    const entries = await Promise.all(
      [...body.entries()].map(async ([name, value]) => {
        if (typeof value === "string") return [name, value];
        const hash = await crypto.subtle.digest(
          "SHA-256",
          await value.arrayBuffer(),
        );
        return [
          name,
          value.name,
          value.type,
          Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        ];
      }),
    );
    payload = JSON.stringify(entries);
  }
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${method}\n${path}\n${payload}`),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** All requests belong to one owner, role and deployment. Dispose before replacing that scope. */
export class StudioClient {
  private disposed = false;
  private controllers = new Set<AbortController>();
  private unresolved = new Map<string, string>();
  private storageKey?: string;
  constructor(
    private readonly transport: typeof fetch = (input, init) =>
      fetch(input, init),
    private readonly timeoutMs = 30_000,
    owner?: string,
  ) {
    this.storageKey = owner ? `asael:studio-mutations:${owner}` : undefined;
    if (this.storageKey && typeof sessionStorage !== "undefined")
      try {
        const saved: unknown = JSON.parse(
          sessionStorage.getItem(this.storageKey) || "[]",
        );
        if (Array.isArray(saved))
          for (const row of saved)
            if (
              Array.isArray(row) &&
              row.length === 2 &&
              typeof row[0] === "string" &&
              /^[a-f0-9]{64}$/.test(row[0]) &&
              typeof row[1] === "string" &&
              row[1]
            )
              this.unresolved.set(row[0], row[1]);
      } catch {
        /* Storage is optional; in-memory recovery remains available. */
      }
  }
  private persistReceipts() {
    if (this.storageKey && typeof sessionStorage !== "undefined")
      try {
        if (this.unresolved.size)
          sessionStorage.setItem(
            this.storageKey,
            JSON.stringify([...this.unresolved]),
          );
        else sessionStorage.removeItem(this.storageKey);
      } catch {
        /* Quota failures do not change the request identity in memory. */
      }
  }
  activate() {
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }
  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.disposed) throw new StudioScopeChanged();
    const method = (init.method || "GET").toUpperCase();
    const mutation = method !== "GET" && method !== "HEAD";
    const headers = new Headers(init.headers);
    const identity = mutation
      ? await mutationIdentity(path, method, init.body)
      : undefined;
    if (this.disposed) throw new StudioScopeChanged();
    if (identity) {
      const key =
        this.unresolved.get(identity) ||
        headers.get("idempotency-key") ||
        crypto.randomUUID();
      headers.set("idempotency-key", key);
      this.unresolved.set(identity, key);
      this.persistReceipts();
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = (async () => {
        const response = await this.transport(path, {
          cache: "no-store",
          ...init,
          headers,
          signal: controller.signal,
        });
        return { response, data: (await response.json()) as unknown };
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new StudioRequestTimeout());
          controller.abort();
        }, this.timeoutMs);
      });
      const { response, data } = await Promise.race([request, timeout]);
      if (this.disposed || controller.signal.aborted)
        throw new StudioScopeChanged();
      if (!response.ok) {
        const body = data as {
          error?: string | { message?: string };
          message?: string;
        };
        const message =
          typeof body.error === "string"
            ? body.error
            : body.error?.message || body.message;
        throw new StudioResponseError(
          message || `Studio request failed (${response.status}).`,
          response.status,
          data,
        );
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error(
          "Studio returned an invalid response. Refresh to recover.",
        );
      if (identity) {
        this.unresolved.delete(identity);
        this.persistReceipts();
      }
      return data as T;
    } catch (error) {
      if (identity && !uncertainFailure(error)) {
        this.unresolved.delete(identity);
        this.persistReceipts();
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  post<T>(path: string, body: unknown, key = crypto.randomUUID()) {
    return this.json<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
  }
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The studio request could not finish. Your draft is retained.";
}
export function uncertainFailure(error: unknown) {
  return (
    !(error instanceof StudioResponseError) ||
    ![400, 401, 403, 404, 409, 422, 429].includes(error.status)
  );
}
