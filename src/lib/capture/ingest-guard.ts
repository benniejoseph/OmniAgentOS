export type CaptureIngestGuard = {
  tenantId: string;
  actorId: string;
  ingestJobId: string;
} & (
  | { kind: "asset"; captureId: string }
  | { kind: "recording"; captureId: string }
);

type CaptureGuardSqlClient = (
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<Array<Record<string, unknown>>>;

export class CaptureIngestInvalidatedError extends Error {
  constructor() {
    super("Capture ingest was invalidated by deletion or replacement.");
    this.name = "CaptureIngestInvalidatedError";
  }
}

export function captureIngestSource(guard: CaptureIngestGuard) {
  return guard.kind === "asset"
    ? `capture:asset:${guard.captureId}`
    : `capture:recording:${guard.captureId}`;
}

export function assertCaptureIngestSource(
  guard: CaptureIngestGuard,
  tenantId: string,
  source: string,
) {
  if (
    guard.tenantId !== tenantId ||
    guard.actorId.trim() !== guard.actorId ||
    !guard.actorId ||
    guard.ingestJobId.trim() !== guard.ingestJobId ||
    !guard.ingestJobId ||
    guard.captureId.trim() !== guard.captureId ||
    !guard.captureId ||
    source !== captureIngestSource(guard)
  ) {
    throw new CaptureIngestInvalidatedError();
  }
}

export async function lockActiveCaptureIngest(
  sql: CaptureGuardSqlClient,
  guard: CaptureIngestGuard,
) {
  const rows = guard.kind === "asset"
    ? await sql`
        SELECT id
        FROM omni_capture_assets
        WHERE tenant_id = ${guard.tenantId}
          AND actor_id = ${guard.actorId}
          AND id = ${guard.captureId}
          AND ingest_job_id = ${guard.ingestJobId}
        FOR UPDATE
      `
    : await sql`
        SELECT id
        FROM omni_capture_recordings
        WHERE tenant_id = ${guard.tenantId}
          AND actor_id = ${guard.actorId}
          AND id = ${guard.captureId}
          AND ingest_job_id = ${guard.ingestJobId}
        FOR UPDATE
      `;
  if (rows.length !== 1) {
    throw new CaptureIngestInvalidatedError();
  }
}
