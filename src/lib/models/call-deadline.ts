/** How long one model call may take, from sending it to reading its body. */
export const MODEL_CALL_TIMEOUT_MS = 300_000;

/**
 * A signal that ends a model call at its deadline, or sooner when the caller
 * aborts. The deadline aborts with a TimeoutError. Check the signal again
 * after reading the body, since a body the deadline cuts off can read as
 * empty rather than fail.
 */
export function modelCallSignal(callerSignal?: AbortSignal) {
  const deadline = AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}
