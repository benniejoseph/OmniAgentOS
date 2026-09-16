export async function startProgressiveThreadLoad<TThread, TRun>(input: {
  readThread: (signal: AbortSignal) => Promise<TThread>;
  latestRunId: (thread: TThread) => string | undefined;
  readRun: (runId: string, signal: AbortSignal) => Promise<TRun>;
  isCurrent: () => boolean;
  onThreadReady: (thread: TThread, latestRunId: string | undefined) => void;
  onRunReady: (run: TRun, latestRunId: string) => void;
  onRunUnavailable?: (error: unknown) => void;
  signal: AbortSignal;
}) {
  const thread = await input.readThread(input.signal);
  if (input.signal.aborted || !input.isCurrent()) return;

  const latestRunId = input.latestRunId(thread);
  input.onThreadReady(thread, latestRunId);
  if (!latestRunId) return;

  void input.readRun(latestRunId, input.signal)
    .then((run) => {
      if (input.signal.aborted || !input.isCurrent()) return;
      input.onRunReady(run, latestRunId);
    })
    .catch((error: unknown) => {
      if (input.signal.aborted || !input.isCurrent()) return;
      input.onRunUnavailable?.(error);
    });
}
