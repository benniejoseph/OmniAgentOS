export const WORKER_PROTOCOL_VERSION = "1";

export type WorkerCompatibilityCheck =
  | {
      accepted: true;
      expectedProtocol: string;
      providedProtocol: string;
      activeRevision?: string;
      providedRevision?: string;
    }
  | {
      accepted: false;
      expectedProtocol: string;
      providedProtocol?: string;
      activeRevision?: string;
      providedRevision?: string;
      status: 409;
      message: string;
    };

export function checkWorkerCompatibility(
  request: Request,
): WorkerCompatibilityCheck {
  const expectedProtocol =
    process.env.OMNIAGENT_WORKER_PROTOCOL_VERSION?.trim() ||
    WORKER_PROTOCOL_VERSION;
  const providedProtocol =
    request.headers.get("x-omni-worker-protocol")?.trim() || undefined;
  const activeRevision =
    process.env.OMNIAGENT_RELEASE_SHA?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    undefined;
  const providedRevision =
    request.headers.get("x-omni-worker-revision")?.trim() || undefined;

  if (providedProtocol !== expectedProtocol) {
    return {
      accepted: false,
      expectedProtocol,
      providedProtocol,
      activeRevision,
      providedRevision,
      status: 409,
      message:
        "The worker protocol is missing or unsupported. Deploy a compatible worker before retrying.",
    };
  }

  return {
    accepted: true,
    expectedProtocol,
    providedProtocol,
    activeRevision,
    providedRevision,
  };
}

export function workerCompatibilityErrorResponse(
  check: Extract<WorkerCompatibilityCheck, { accepted: false }>,
) {
  return Response.json(
    {
      error: "Worker protocol rejected",
      message: check.message,
      expectedProtocol: check.expectedProtocol,
      providedProtocol: check.providedProtocol,
      activeRevision: check.activeRevision,
      providedRevision: check.providedRevision,
    },
    { status: check.status },
  );
}
