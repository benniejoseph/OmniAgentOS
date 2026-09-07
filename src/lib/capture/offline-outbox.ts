import { createHash, timingSafeEqual } from "node:crypto";

const OFFLINE_CAPTURE_KEY = /^capture-offline-[A-Za-z0-9_-]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class OfflineCaptureOwnerBindingError extends Error {
  constructor(message = "The offline capture owner binding is invalid.") {
    super(message);
    this.name = "OfflineCaptureOwnerBindingError";
  }
}

export function assertOfflineCaptureOwnerBinding(input: {
  idempotencyKey?: string;
  correlationId?: string;
  ownerSha256?: string;
  tenantId: string;
  actorId: string;
}) {
  const idempotencyKey = input.idempotencyKey?.trim() || "";
  if (!idempotencyKey.startsWith("capture-offline-")) return;
  if (!OFFLINE_CAPTURE_KEY.test(idempotencyKey)) {
    throw new OfflineCaptureOwnerBindingError(
      "The offline capture idempotency key is invalid.",
    );
  }
  if (input.correlationId?.trim() !== idempotencyKey) {
    throw new OfflineCaptureOwnerBindingError(
      "The offline capture correlation binding is invalid.",
    );
  }
  const supplied = input.ownerSha256?.trim() || "";
  const expected = offlineCaptureOwnerSha256(input.tenantId, input.actorId);
  if (
    !SHA256.test(supplied) ||
    !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))
  ) {
    throw new OfflineCaptureOwnerBindingError();
  }
}

export function offlineCaptureOwnerSha256(tenantId: string, actorId: string) {
  return createHash("sha256")
    .update(`asael.capture-outbox-owner:1\0${tenantId}\0${actorId}`)
    .digest("hex");
}
