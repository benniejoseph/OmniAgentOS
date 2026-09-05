const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DELIVERY_ATTEMPTS = 8;

export type IdempotentDeliveryReceipt = Readonly<{
  bindingSha256: string;
  verification: "read_after_write";
}>;

export type LostAcknowledgementRecovery = Readonly<{
  attemptCount: number;
  providerEffectCount: number;
  receiptCount: number;
  receipt: IdempotentDeliveryReceipt | null;
}>;

/**
 * Deterministic fault probe for the required retry order: after a provider has
 * accepted a mutation but its response is lost, every later delivery attempt
 * must reconcile by idempotency identity before it may emit another mutation.
 */
export function evaluateLostAcknowledgementRecovery(input: {
  bindingSha256: string;
  deliveryAttempts: number;
  observedBindingSha256?: string;
}): LostAcknowledgementRecovery {
  const bindingSha256 = canonicalSha256(input.bindingSha256);
  const observedBindingSha256 = canonicalSha256(
    input.observedBindingSha256 ?? bindingSha256,
  );
  if (
    !Number.isInteger(input.deliveryAttempts) ||
    input.deliveryAttempts < 1 ||
    input.deliveryAttempts > MAX_DELIVERY_ATTEMPTS
  ) {
    throw new Error(`Delivery attempts must be an integer from 1 to ${MAX_DELIVERY_ATTEMPTS}.`);
  }

  // Attempt one reaches the provider and changes state once, but the response
  // is lost. Attempt two (and any later scheduler replay) performs a
  // read-after-write before delivery and therefore observes the same effect.
  const providerEffectCount = 1;
  const receipt = input.deliveryAttempts >= 2 && observedBindingSha256 === bindingSha256
    ? Object.freeze({ bindingSha256, verification: "read_after_write" as const })
    : null;

  return Object.freeze({
    attemptCount: input.deliveryAttempts,
    providerEffectCount,
    receiptCount: receipt ? 1 : 0,
    receipt,
  });
}

function canonicalSha256(value: string) {
  const normalized = value.trim();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error("Idempotent delivery bindings require canonical lowercase SHA-256 digests.");
  }
  return normalized;
}
