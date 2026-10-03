type RecordingStream = { getTracks(): { stop(): void }[] };
type CreationResponse = { ok: boolean; json(): Promise<unknown> };

export function createCaptureRecordingStartAttempt() {
  let canceled = false;
  let stream: RecordingStream | undefined;
  let streamStopped = false;
  let handedOff = false;

  function stopStream() {
    if (!stream || streamStopped) return;
    streamStopped = true;
    stream.getTracks().forEach((track) => track.stop());
  }

  return {
    isCurrent: () => !canceled,
    cancel() {
      canceled = true;
      // Once activated, the component retains its existing recorder-stop order.
      if (!handedOff) stopStream();
    },
    attachStream(nextStream: RecordingStream) {
      stream = nextStream;
      if (canceled) stopStream();
    },
    handOffStream() { handedOff = true; },
    stopStream,
    guard<Arguments extends unknown[]>(callback: (...args: Arguments) => void) {
      return (...args: Arguments) => {
        if (!canceled) callback(...args);
      };
    },
  };
}

export type CaptureRecordingStartAttempt = ReturnType<typeof createCaptureRecordingStartAttempt>;

type StartOptions<Stream extends RecordingStream> = {
  attempt: CaptureRecordingStartAttempt;
  requestMicrophone: () => Promise<Stream>;
  createRecording: () => Promise<CreationResponse>;
  discardRecording: (id: string) => Promise<void>;
  activateRecorder: (stream: Stream, id: string) => void;
  onCleanupIssue: (message: string) => void;
};

const unknownCreationMessage = "Recording setup was canceled, but the session-creation response could not be verified. Refresh recording history to check for an unfinished session.";

export async function startCaptureRecording<Stream extends RecordingStream>({
  attempt,
  requestMicrophone,
  createRecording,
  discardRecording,
  activateRecorder,
  onCleanupIssue,
}: StartOptions<Stream>): Promise<"started" | "canceled"> {
  if (!attempt.isCurrent()) return "canceled";
  let creationRequested = false;
  let createdId: string | undefined;

  async function cleanCreatedRecording(id: string) {
    try {
      await discardRecording(id);
    } catch {
      onCleanupIssue(`Deletion of recording session ${id} could not be confirmed. Refresh recording history to check this unfinished session.`);
    }
  }

  try {
    const stream = await requestMicrophone();
    attempt.attachStream(stream);
    if (!attempt.isCurrent()) return "canceled";

    creationRequested = true;
    const response = await createRecording();
    if (!attempt.isCurrent()) attempt.stopStream();
    // Even after cancellation, read this response to clean up its exact session.
    // Aborting here could hide a session that the server already created.
    const payload = await response.json().catch(() => undefined);
    const canceledAfterResponse = !attempt.isCurrent();
    const body = typeof payload === "object" && payload !== null
      ? payload as { recording?: { id?: unknown }; error?: unknown }
      : undefined;
    const id = body?.recording?.id;
    createdId = typeof id === "string" && id ? id : undefined;

    if (canceledAfterResponse) {
      attempt.stopStream();
      if (createdId) await cleanCreatedRecording(createdId);
      else if (response.ok) onCleanupIssue(unknownCreationMessage);
      return "canceled";
    }
    if (!response.ok || !createdId) {
      throw new Error(typeof body?.error === "string" ? body.error : "The recording could not be started.");
    }

    activateRecorder(stream, createdId);
    attempt.handOffStream();
    return "started";
  } catch (error) {
    attempt.stopStream();
    if (!attempt.isCurrent()) {
      if (createdId) await cleanCreatedRecording(createdId);
      if (creationRequested && !createdId) onCleanupIssue(unknownCreationMessage);
      return "canceled";
    }
    // Preserve immediate error recovery while deletion is attempted in the background.
    if (createdId) void cleanCreatedRecording(createdId);
    throw error;
  }
}
