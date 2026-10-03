import { describe, expect, it, vi } from "vitest";
import {
  createCaptureRecordingStartAttempt,
  startCaptureRecording,
} from "./long-recording-start";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(id = "recording-exact") {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  const response = { ok: true, json: vi.fn(async () => ({ recording: { id } })) };
  return {
    stop,
    stream,
    response,
    options: {
      attempt: createCaptureRecordingStartAttempt(),
      requestMicrophone: vi.fn(async () => stream),
      createRecording: vi.fn(async () => response),
      discardRecording: vi.fn(async (_id: string) => undefined),
      activateRecorder: vi.fn((_stream: typeof stream, _id: string) => undefined),
      onCleanupIssue: vi.fn((_message: string) => undefined),
    },
  };
}

describe("Capture recording startup cancellation", () => {
  it("does not request a device for an already canceled attempt", async () => {
    const { options } = fixture();
    options.attempt.cancel();

    expect(await startCaptureRecording(options)).toBe("canceled");
    expect(options.requestMicrophone).not.toHaveBeenCalled();
    expect(options.createRecording).not.toHaveBeenCalled();
  });

  it("stops a late permission stream after discard or unmount without creating a session", async () => {
    const { options, stream, stop } = fixture();
    const permission = deferred<typeof stream>();
    options.requestMicrophone.mockImplementation(() => permission.promise);
    const result = startCaptureRecording(options);

    options.attempt.cancel();
    permission.resolve(stream);

    expect(await result).toBe("canceled");
    expect(stop).toHaveBeenCalledOnce();
    expect(options.createRecording).not.toHaveBeenCalled();
    expect(options.activateRecorder).not.toHaveBeenCalled();
    expect(options.discardRecording).not.toHaveBeenCalled();
    expect(options.onCleanupIssue).not.toHaveBeenCalled();
  });

  it("ignores a late permission rejection after cancellation", async () => {
    const { options, stream: _stream } = fixture();
    const permission = deferred<typeof _stream>();
    options.requestMicrophone.mockImplementation(() => permission.promise);
    const result = startCaptureRecording(options);

    options.attempt.cancel();
    permission.reject(new Error("Microphone permission denied"));

    expect(await result).toBe("canceled");
    expect(options.createRecording).not.toHaveBeenCalled();
    expect(options.activateRecorder).not.toHaveBeenCalled();
    expect(options.onCleanupIssue).not.toHaveBeenCalled();
  });

  it("stops the setup stream immediately and deletes the exact late-created session", async () => {
    const { options, response, stop } = fixture("late/session-exact");
    const creation = deferred<typeof response>();
    const creationRequested = deferred<void>();
    options.createRecording.mockImplementation(() => {
      creationRequested.resolve();
      return creation.promise;
    });
    const result = startCaptureRecording(options);
    await creationRequested.promise;

    options.attempt.cancel();
    expect(stop).toHaveBeenCalledOnce();
    creation.resolve(response);

    expect(await result).toBe("canceled");
    expect(options.discardRecording).toHaveBeenCalledExactlyOnceWith("late/session-exact");
    expect(options.activateRecorder).not.toHaveBeenCalled();
    expect(options.onCleanupIssue).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after the response body resolves before activating a recorder", async () => {
    const { options, response, stop } = fixture();
    const body = deferred<{ recording: { id: string } }>();
    const bodyRequested = deferred<void>();
    response.json.mockImplementation(() => {
      bodyRequested.resolve();
      return body.promise;
    });
    const result = startCaptureRecording(options);
    await bodyRequested.promise;

    options.attempt.cancel();
    body.resolve({ recording: { id: "body-late-session" } });

    expect(await result).toBe("canceled");
    expect(stop).toHaveBeenCalledOnce();
    expect(options.discardRecording).toHaveBeenCalledExactlyOnceWith("body-late-session");
    expect(options.activateRecorder).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed deletion without activating the canceled session", async () => {
    const { options, response } = fixture("cleanup-failed-exact-id");
    const creation = deferred<typeof response>();
    const creationRequested = deferred<void>();
    options.createRecording.mockImplementation(() => {
      creationRequested.resolve();
      return creation.promise;
    });
    options.discardRecording.mockRejectedValue(new Error("DELETE unavailable"));
    const result = startCaptureRecording(options);
    await creationRequested.promise;

    options.attempt.cancel();
    creation.resolve(response);

    expect(await result).toBe("canceled");
    expect(options.activateRecorder).not.toHaveBeenCalled();
    expect(options.onCleanupIssue).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("cleanup-failed-exact-id could not be confirmed"));
  });

  it("reports an unknown creation result instead of claiming a canceled session was deleted", async () => {
    const { options, response: _response } = fixture();
    const creation = deferred<typeof _response>();
    const creationRequested = deferred<void>();
    options.createRecording.mockImplementation(() => {
      creationRequested.resolve();
      return creation.promise;
    });
    const result = startCaptureRecording(options);
    await creationRequested.promise;

    options.attempt.cancel();
    creation.reject(new Error("Connection ended before the creation response"));

    expect(await result).toBe("canceled");
    expect(options.activateRecorder).not.toHaveBeenCalled();
    expect(options.discardRecording).not.toHaveBeenCalled();
    expect(options.onCleanupIssue).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("session-creation response could not be verified"));
  });

  it("does not let a late canceled attempt stop or activate over a replacement attempt", async () => {
    const older = fixture("older-session");
    const newer = fixture("newer-session");
    const permission = deferred<typeof older.stream>();
    older.options.requestMicrophone.mockImplementation(() => permission.promise);
    const olderResult = startCaptureRecording(older.options);
    older.options.attempt.cancel();

    expect(await startCaptureRecording(newer.options)).toBe("started");
    permission.resolve(older.stream);

    expect(await olderResult).toBe("canceled");
    expect(older.stop).toHaveBeenCalledOnce();
    expect(newer.stop).not.toHaveBeenCalled();
    expect(older.options.activateRecorder).not.toHaveBeenCalled();
    expect(newer.options.activateRecorder).toHaveBeenCalledExactlyOnceWith(newer.stream, "newer-session");
  });

  it("keeps valid chunk callbacks and suppresses late callbacks once their attempt is canceled", async () => {
    const { options, stream, stop } = fixture();
    const uploadChunk = vi.fn((_id: string, _chunk: string) => undefined);
    let emitChunk: (chunk: string) => void = () => { throw new Error("Recorder was not activated"); };
    options.activateRecorder.mockImplementation((_stream, id) => {
      emitChunk = options.attempt.guard((chunk: string) => uploadChunk(id, chunk));
    });

    expect(await startCaptureRecording(options)).toBe("started");
    expect(options.activateRecorder).toHaveBeenCalledExactlyOnceWith(stream, "recording-exact");
    emitChunk("valid-chunk");
    options.attempt.cancel();
    emitChunk("late-chunk");

    expect(uploadChunk).toHaveBeenCalledExactlyOnceWith("recording-exact", "valid-chunk");
    // After activation, the component owns the existing stop/flush sequence.
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops the stream and cleans up the exact session when recorder activation fails", async () => {
    const { options, stop } = fixture("activation-failed-session");
    const failure = new Error("MediaRecorder setup failed");
    options.activateRecorder.mockImplementation(() => { throw failure; });

    await expect(startCaptureRecording(options)).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledOnce();
    expect(options.discardRecording).toHaveBeenCalledExactlyOnceWith("activation-failed-session");
    expect(options.onCleanupIssue).not.toHaveBeenCalled();
  });

  it("reports activation failure immediately while its cleanup request is still pending", async () => {
    const { options, stop } = fixture("cleanup-pending-session");
    const cleanup = deferred<undefined>();
    const failure = new Error("MediaRecorder setup failed");
    options.activateRecorder.mockImplementation(() => { throw failure; });
    options.discardRecording.mockImplementation(() => cleanup.promise);

    await expect(startCaptureRecording(options)).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledOnce();
    expect(options.discardRecording).toHaveBeenCalledExactlyOnceWith("cleanup-pending-session");
    cleanup.resolve(undefined);
  });
});
