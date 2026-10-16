/** Content-free read failure contract, safe to load without the reader runtime. */
export type PublicWebReadFailureCode =
  | "source_access_restricted"
  | "source_not_readable"
  | "source_too_large"
  | "source_rate_limited"
  | "source_http_error"
  | "source_timeout"
  | "source_unsupported";

export type PublicWebReadFailureDetails = {
  version: 1;
  code: PublicWebReadFailureCode;
  httpStatus?: number;
  retrySameSource: false;
  recoveryHint: string;
};

const failureMessages: Record<PublicWebReadFailureCode, string> = {
  source_access_restricted: "This source requires access, a subscription, or blocks automated reading. Choose a publicly readable source.",
  source_not_readable: "This page has too little readable text or requires JavaScript. Choose another source; no browser scripts were executed.",
  source_too_large: "Public source exceeds the reading limit. Choose a smaller source.",
  source_rate_limited: "Public source returned HTTP 429. Try another source.",
  source_http_error: "Public source returned an unsuccessful HTTP status. Try another source.",
  source_timeout: "Public source reading timed out after 15 seconds. Try another source.",
  source_unsupported: "This source is not a supported HTML, text, or PDF document. Choose a readable public source.",
};

function failureDetails(code: PublicWebReadFailureCode, httpStatus?: number): PublicWebReadFailureDetails {
  return {
    version: 1, code, ...(httpStatus === undefined ? {} : { httpStatus }), retrySameSource: false,
    recoveryHint: code === "source_access_restricted"
      ? "Do not retry this URL or bypass its access restrictions. Use another public source or an admitted search; disclose any remaining evidence gap."
      : "Do not repeat this URL in the current run. Use another readable public source or an admitted search; disclose any remaining evidence gap.",
  };
}

/** Decode persisted metadata, rebuilding guidance from the local code rather
 * than trusting text carried by a tool result or continuation. */
export function readPublicWebReadFailureDetails(value: unknown): PublicWebReadFailureDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["version", "code", "httpStatus", "retrySameSource", "recoveryHint"].includes(key)) ||
    input.version !== 1 || typeof input.code !== "string" || !Object.hasOwn(failureMessages, input.code) ||
    input.retrySameSource !== false || typeof input.recoveryHint !== "string" || input.recoveryHint.length > 300) return;
  const code = input.code as PublicWebReadFailureCode;
  const status = input.httpStatus;
  if (status !== undefined && (typeof status !== "number" || !Number.isInteger(status) || status < 300 || status > 599)) return;
  if (code === "source_access_restricted" ? status !== undefined && ![401, 402, 403].includes(status as number)
    : code === "source_rate_limited" ? status !== 429
      : code === "source_http_error" ? status === undefined || [401, 402, 403, 429].includes(status as number)
        : status !== undefined) return;
  return failureDetails(code, status as number | undefined);
}

/** Expected retrieval failures remain failed tool receipts, with fixed recovery
 * metadata. Neither response text nor request URLs enter this error contract. */
export class PublicWebReadError extends Error {
  readonly details: PublicWebReadFailureDetails;

  constructor(code: PublicWebReadFailureCode, options: { httpStatus?: number; limitMiB?: 1 | 5 } = {}) {
    // Non-followed 3xx responses are also unsuccessful public reads; preserve
    // their exact status so the emitted metadata remains decodable on resume.
    const httpStatus = Number.isInteger(options.httpStatus) && options.httpStatus! >= 300 && options.httpStatus! <= 599
      ? options.httpStatus : undefined;
    const message = code === "source_too_large" && options.limitMiB
      ? `Public source exceeds the ${options.limitMiB} MiB reading limit. Choose a smaller source.`
      : code === "source_http_error" && httpStatus
        ? `Public source returned HTTP ${httpStatus}. Try another source.`
        : failureMessages[code];
    super(message);
    this.name = "PublicWebReadError";
    this.details = Object.freeze(failureDetails(code, httpStatus));
  }
}

export function publicWebReadFailureDetails(error: unknown): PublicWebReadFailureDetails | undefined {
  return error instanceof PublicWebReadError ? error.details : undefined;
}

