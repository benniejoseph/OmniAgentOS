import { parseReceipt, type Receipt, type Submission } from "./operational-contracts";

export function createOperationalGate() {
  let alive = true; let epoch = 0; let read = 0; let write = 0; let pending: number | undefined;
  return {
    activate() { alive = true; epoch += 1; },
    dispose() { alive = false; epoch += 1; read += 1; pending = undefined; },
    beginRead() { return { epoch, read: ++read }; },
    currentRead(token: { epoch: number; read: number }) { return alive && token.epoch === epoch && token.read === read; },
    beginWrite() { if (!alive || pending !== undefined) return undefined; pending = ++write; return { epoch, write }; },
    currentWrite(token: { epoch: number; write: number }) { return alive && token.epoch === epoch && pending === token.write; },
    finishWrite(token: { epoch: number; write: number }) { if (!alive || token.epoch !== epoch || pending !== token.write) return false; pending = undefined; return true; },
  };
}
export type ActionOutcome = { state: "confirmed"; receipt: Receipt } | { state: "rejected" | "uncertain"; message: string };
export async function requestOperationalAction(submission: Submission, fetcher: typeof fetch = fetch): Promise<ActionOutcome> {
  try {
    const response = await fetcher(submission.path, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json", "idempotency-key": submission.key },
      body: JSON.stringify(submission.body), signal: AbortSignal.timeout(30_000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const rejected = [400, 401, 403, 404, 409, 413, 422].includes(response.status);
      const raw = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const message = typeof raw.error === "string" ? raw.error : typeof raw.message === "string" ? raw.message : `Request returned ${response.status}.`;
      return { state: rejected ? "rejected" : "uncertain", message };
    }
    try { return { state: "confirmed", receipt: parseReceipt(submission, body) }; }
    catch { return { state: "uncertain", message: "The server responded, but its receipt could not be matched to this request. The action may already have taken effect." }; }
  } catch {
    return { state: "uncertain", message: "The action outcome could not be confirmed. A timeout or lost connection does not cancel work already received by the server." };
  }
}
