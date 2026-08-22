export type WorkerRevisionCheck =
  | {
      accepted: true;
      expectedRevision?: string;
      providedRevision?: string;
    }
  | {
      accepted: false;
      expectedRevision?: string;
      providedRevision?: string;
      status: 409 | 503;
      message: string;
    };

export function checkWorkerRevision(request: Request): WorkerRevisionCheck {
  const expectedRevision =
    process.env.OMNIAGENT_RELEASE_SHA?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    undefined;
  const providedRevision =
    request.headers.get("x-omni-worker-revision")?.trim() || undefined;

  if (!expectedRevision) {
    if (process.env.NODE_ENV === "production") {
      return {
        accepted: false,
        providedRevision,
        status: 503,
        message:
          "The web release revision is unavailable; worker mutations are disabled.",
      };
    }
    return { accepted: true, providedRevision };
  }

  if (providedRevision !== expectedRevision) {
    return {
      accepted: false,
      expectedRevision,
      providedRevision,
      status: 409,
      message:
        "The worker revision does not match the active web release. Deploy matching revisions before retrying.",
    };
  }

  return {
    accepted: true,
    expectedRevision,
    providedRevision,
  };
}

export function workerRevisionErrorResponse(
  check: Extract<WorkerRevisionCheck, { accepted: false }>,
) {
  return Response.json(
    {
      error: "Worker revision rejected",
      message: check.message,
      expectedRevision: check.expectedRevision,
      providedRevision: check.providedRevision,
    },
    { status: check.status },
  );
}
