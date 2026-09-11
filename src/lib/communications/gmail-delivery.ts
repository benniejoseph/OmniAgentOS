import { createHash } from "node:crypto";
import { getActiveGoogleWorkspaceAccess } from "@/lib/connectors/google-workspace-access";
import type { MessageDraft } from "@/lib/communications/contracts";
import { messageDraftSchema } from "@/lib/communications/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailDeliveryEffectResult = Readonly<{
  providerMessageId: string;
  externalThreadId: string;
  providerAcknowledgement:
    | "provider_response"
    | "provider_idempotency_reconciliation";
  providerAcknowledgementSha256: string;
  observedTargetStateSha256: string;
}>;

export class GmailDeliveryOutcomeUnknownError extends Error {
  constructor(message = "Gmail delivery outcome is unknown; no duplicate retry was sent.", options?: ErrorOptions) {
    super(message, options);
    this.name = "GmailDeliveryOutcomeUnknownError";
  }
}

export function gmailRfcMessageId(draftSha256: string) {
  if (!/^[a-f0-9]{64}$/.test(draftSha256)) {
    throw new Error("Gmail draft digest is invalid.");
  }
  return `<asael.${draftSha256}@asael.bennierichard.com>`;
}

export function gmailDraftTargetState(input: MessageDraft) {
  const draft = messageDraftSchema.parse(input);
  if (draft.channel !== "email") {
    throw new Error("Gmail delivery requires an email draft.");
  }
  return {
    targetType: "gmail_message",
    draftSha256: draft.draftSha256,
    messageId: gmailRfcMessageId(draft.draftSha256),
    recipient: draft.recipient.toLowerCase(),
    subject: draft.subject,
    bodySha256: sha256(draft.body),
  } as const;
}

export function buildGmailRawMessage(input: MessageDraft) {
  const target = gmailDraftTargetState(input);
  const subject = encodeHeader(input.subject);
  const body = wrapBase64(Buffer.from(input.body, "utf8").toString("base64"));
  return [
    `To: ${target.recipient}`,
    `Subject: ${subject}`,
    `Message-ID: ${target.messageId}`,
    `X-Asael-Draft-SHA256: ${input.draftSha256}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

export async function deliverGmailDraft(input: MessageDraft, options: {
  tenantId: string;
  actorId: string;
  mode: "deliver" | "reconcile";
  abortSignal?: AbortSignal;
}): Promise<GmailDeliveryEffectResult> {
  const draft = messageDraftSchema.parse(input);
  const authorization = await googleAuthorization(options);
  let prior: Record<string, unknown> | undefined;
  try {
    prior = await findGmailMessage(
      draft,
      authorization.accessToken,
      options.abortSignal,
    );
  } catch (error) {
    if (options.mode !== "reconcile") throw error;
    if (error instanceof GmailDeliveryOutcomeUnknownError) throw error;
    throw new GmailDeliveryOutcomeUnknownError(
      "Gmail reconciliation is inconclusive; no duplicate retry was sent.",
      { cause: error },
    );
  }
  if (prior) {
    return verifiedResult(
      draft,
      prior,
      "provider_idempotency_reconciliation",
    );
  }
  if (options.mode === "reconcile") {
    throw new GmailDeliveryOutcomeUnknownError(
      "Gmail did not yet expose the prior delivery attempt; no duplicate retry was sent.",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${GMAIL_API}/messages/send`, {
      method: "POST",
      headers: googleHeaders(authorization.accessToken, true),
      body: JSON.stringify({
        raw: Buffer.from(buildGmailRawMessage(draft), "utf8").toString("base64url"),
      }),
      signal: providerSignal(options.abortSignal),
    });
  } catch (error) {
    throw new GmailDeliveryOutcomeUnknownError(undefined, { cause: error });
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      throw new GmailDeliveryOutcomeUnknownError(
        `Gmail delivery returned ${response.status}; no duplicate retry was sent.`,
      );
    }
    throw new Error(`Gmail rejected delivery with status ${response.status}.`);
  }
  try {
    const acknowledgement = record(await response.json());
    const providerMessageId = requiredProviderId(acknowledgement.id, "message");
    const observed = await readGmailMessage(
      providerMessageId,
      authorization.accessToken,
      options.abortSignal,
    );
    if (!observed) {
      throw new GmailDeliveryOutcomeUnknownError(
        "Gmail accepted the message but its target state could not be verified.",
      );
    }
    return verifiedResult(draft, observed, "provider_response");
  } catch (error) {
    if (error instanceof GmailDeliveryOutcomeUnknownError) throw error;
    throw new GmailDeliveryOutcomeUnknownError(
      "Gmail accepted the send request but its exact outcome could not be verified; no duplicate retry was sent.",
      { cause: error },
    );
  }
}

async function findGmailMessage(
  draft: MessageDraft,
  accessToken: string,
  abortSignal?: AbortSignal,
) {
  const url = new URL(`${GMAIL_API}/messages`);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("q", `rfc822msgid:${gmailRfcMessageId(draft.draftSha256)}`);
  const response = await fetch(url, {
    headers: googleHeaders(accessToken),
    signal: providerSignal(abortSignal),
  });
  if (!response.ok) {
    throw new Error(`Gmail reconciliation returned ${response.status}.`);
  }
  const body = record(await response.json());
  for (const candidate of array(body.messages)) {
    const providerMessageId = String(record(candidate).id || "").trim();
    if (!providerMessageId) continue;
    const observed = await readGmailMessage(providerMessageId, accessToken, abortSignal);
    if (!observed) continue;
    assertObservedTarget(draft, observed);
    return observed;
  }
  return undefined;
}

async function readGmailMessage(
  providerMessageId: string,
  accessToken: string,
  abortSignal?: AbortSignal,
) {
  const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(providerMessageId)}`);
  url.searchParams.set("format", "raw");
  const response = await fetch(url, {
    headers: googleHeaders(accessToken),
    signal: providerSignal(abortSignal),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new GmailDeliveryOutcomeUnknownError(
      `Gmail target verification returned ${response.status}.`,
    );
  }
  return record(await response.json());
}

function verifiedResult(
  draft: MessageDraft,
  observed: Record<string, unknown>,
  acknowledgement: GmailDeliveryEffectResult["providerAcknowledgement"],
) {
  const observedTargetStateSha256 = assertObservedTarget(draft, observed);
  const providerMessageId = requiredProviderId(observed.id, "message");
  const externalThreadId = requiredProviderId(observed.threadId, "thread");
  return Object.freeze({
    providerMessageId,
    externalThreadId,
    providerAcknowledgement: acknowledgement,
    providerAcknowledgementSha256: canonicalJsonSha256({
      provider: "gmail",
      acknowledgement,
      providerMessageId,
      externalThreadId,
      draftSha256: draft.draftSha256,
      observedTargetStateSha256,
    }),
    observedTargetStateSha256,
  });
}

function assertObservedTarget(draft: MessageDraft, observed: Record<string, unknown>) {
  const raw = typeof observed.raw === "string"
    ? Buffer.from(observed.raw, "base64url").toString("utf8")
    : "";
  const parsed = parseRawMessage(raw);
  const expected = gmailDraftTargetState(draft);
  const actual = {
    targetType: "gmail_message",
    draftSha256: parsed.headers.get("x-asael-draft-sha256") || "",
    messageId: parsed.headers.get("message-id") || "",
    recipient: normalizeMailbox(parsed.headers.get("to") || ""),
    subject: decodeHeader(parsed.headers.get("subject") || ""),
    bodySha256: sha256(parsed.body),
  };
  const actualSha256 = canonicalJsonSha256(actual);
  if (actualSha256 !== canonicalJsonSha256(expected)) {
    throw new GmailDeliveryOutcomeUnknownError(
      "Gmail message does not match the exact governed draft.",
    );
  }
  return actualSha256;
}

function parseRawMessage(raw: string) {
  const separator = raw.search(/\r?\n\r?\n/);
  if (separator < 0) return { headers: new Map<string, string>(), body: "" };
  const headerText = raw.slice(0, separator).replace(/\r?\n[ \t]+/g, " ");
  const separatorMatch = raw.slice(separator).match(/^\r?\n\r?\n/);
  const bodyText = raw.slice(separator + (separatorMatch?.[0].length || 2));
  const headers = new Map<string, string>();
  for (const line of headerText.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const transferEncoding = headers.get("content-transfer-encoding")?.toLowerCase();
  const body = transferEncoding === "base64"
    ? Buffer.from(bodyText.replace(/\s+/g, ""), "base64").toString("utf8")
    : bodyText;
  return { headers, body };
}

async function googleAuthorization(input: { tenantId: string; actorId: string }) {
  return getActiveGoogleWorkspaceAccess({
    tenantId: input.tenantId,
    actorId: input.actorId,
    capability: "gmail.send",
  });
}

function encodeHeader(value: string) {
  if (/[\r\n]/.test(value)) throw new Error("Gmail subject cannot contain line breaks.");
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function decodeHeader(value: string) {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_match, encoded: string) =>
    Buffer.from(encoded, "base64").toString("utf8"));
}

function normalizeMailbox(value: string) {
  const match = value.match(/<([^<>]+)>/);
  return (match?.[1] || value).trim().toLowerCase();
}

function wrapBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") || "";
}

function requiredProviderId(value: unknown, label: string) {
  const id = String(value || "").trim();
  if (!id || id.length > 500) throw new GmailDeliveryOutcomeUnknownError(`Gmail ${label} ID is invalid.`);
  return id;
}

function googleHeaders(accessToken: string, json = false) {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function providerSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
