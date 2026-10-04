/** A mounted owner's read/transport lifetime; it never grants server authority. */
export class CommandWorkspaceScope {
  private controller = new AbortController();
  private available: boolean;

  constructor(available: boolean) {
    this.available = available;
    if (!available) this.controller.abort();
  }

  setAvailable(available: boolean) {
    if (available === this.available) return;
    this.available = available;
    this.controller.abort();
    if (available) this.controller = new AbortController();
  }

  current = () => this.available && !this.controller.signal.aborted;

  capture() {
    const signal = this.controller.signal;
    return {
      signal,
      current: () => this.current() && this.controller.signal === signal && !signal.aborted,
    };
  }

  async run<T>(read: (signal: AbortSignal) => Promise<T>, upstream?: AbortSignal | null): Promise<T> {
    const lease = this.capture();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const assertCurrent = () => {
      if (!lease.current() || upstream?.aborted) throw new DOMException("Workspace access changed. The response was not adopted.", "AbortError");
    };
    assertCurrent();
    lease.signal.addEventListener("abort", abort, { once: true });
    upstream?.addEventListener("abort", abort, { once: true });
    let cancelWait: (() => void) | undefined;
    try {
      const canceled = new Promise<never>((_resolve, reject) => {
        cancelWait = () => reject(new DOMException("Workspace access changed. The outcome is unconfirmed.", "AbortError"));
        controller.signal.addEventListener("abort", cancelWait, { once: true });
      });
      const result = await Promise.race([read(controller.signal), canceled]);
      assertCurrent();
      return result;
    } catch (error) {
      assertCurrent();
      throw error;
    } finally {
      if (cancelWait) controller.signal.removeEventListener("abort", cancelWait);
      lease.signal.removeEventListener("abort", abort);
      upstream?.removeEventListener("abort", abort);
    }
  }
}

/** Exact selected-read correlation, including a late response for a prior key. */
export class CommandSelectionRead {
  private revision = 0;
  private controller?: AbortController;

  cancel() {
    this.revision += 1;
    this.controller?.abort();
  }

  begin(id: string) {
    this.cancel();
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    return { id, signal: controller.signal,
      current: () => revision === this.revision && !controller.signal.aborted };
  }
}
