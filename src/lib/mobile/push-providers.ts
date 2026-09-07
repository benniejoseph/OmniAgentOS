import { createSign } from "node:crypto";
import { connect } from "node:http2";
import type {
  MobilePushEnvelope,
  MobilePushPreviewPolicy,
  MobilePushTarget,
} from "@/lib/mobile/push-contract";
import { mobilePushPreview } from "@/lib/mobile/push-contract";

const providerDeadlineMs = 10_000;
const maxProviderResponseBytes = 16_384;
const oauthScope = "https://www.googleapis.com/auth/firebase.messaging";
const oauthAudience = "https://oauth2.googleapis.com/token";

type PushProvider = "apns" | "fcm";
type PushEnvironment = "sandbox" | "production";

export class MobilePushProviderError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly code: string,
  ) {
    super(message);
    this.name = "MobilePushProviderError";
  }
}

export function mobilePushProviderConfiguration() {
  return Object.freeze({
    apns: apnsConfiguration() ? "configured" as const : "configuration_required" as const,
    fcm: fcmConfiguration() ? "configured" as const : "configuration_required" as const,
  });
}

export async function deliverMobilePush(input: {
  provider: PushProvider;
  environment: PushEnvironment;
  token: string;
  target: MobilePushTarget;
  envelope: MobilePushEnvelope;
  previewPolicy: MobilePushPreviewPolicy;
  sensitiveTitle?: string;
}) {
  const preview = mobilePushPreview(
    input.previewPolicy,
    input.target,
    input.sensitiveTitle,
  );
  return input.provider === "apns"
    ? deliverApns({ ...input, preview })
    : deliverFcm({ ...input, preview });
}

async function deliverFcm(input: {
  token: string;
  envelope: MobilePushEnvelope;
  preview?: { title: string; body: string };
}) {
  const config = fcmConfiguration();
  if (!config) {
    throw new MobilePushProviderError(
      "FCM delivery credentials are not configured.",
      false,
      "configuration_required",
    );
  }
  const accessToken = await fcmAccessToken(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerDeadlineMs);
  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: input.token,
            data: stringRecord(input.envelope),
            ...(input.preview ? { notification: input.preview } : {}),
            android: { priority: "HIGH" },
            apns: {
              headers: {
                "apns-push-type": input.preview ? "alert" : "background",
                "apns-priority": input.preview ? "10" : "5",
              },
              payload: {
                aps: input.preview
                  ? { sound: "default" }
                  : { "content-available": 1 },
              },
            },
          },
        }),
        signal: controller.signal,
      },
    );
    const body = await boundedResponseText(response);
    const parsed = parseJson(body);
    if (!response.ok) {
      const providerCode = nestedString(parsed, ["error", "details", "0", "errorCode"])
        || nestedString(parsed, ["error", "status"])
        || `http_${response.status}`;
      throw new MobilePushProviderError(
        `FCM rejected delivery (${providerCode}).`,
        response.status === 400 || response.status === 404 || providerCode === "UNREGISTERED",
        providerCode,
      );
    }
    const messageId = typeof parsed.name === "string" ? parsed.name : undefined;
    if (!messageId) {
      throw new MobilePushProviderError(
        "FCM returned an invalid delivery receipt.",
        false,
        "invalid_receipt",
      );
    }
    return { messageId };
  } catch (error) {
    if (error instanceof MobilePushProviderError) throw error;
    throw new MobilePushProviderError(
      error instanceof Error && error.name === "AbortError"
        ? "FCM delivery timed out."
        : "FCM delivery failed.",
      false,
      "transport_error",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverApns(input: {
  environment: PushEnvironment;
  token: string;
  envelope: MobilePushEnvelope;
  preview?: { title: string; body: string };
}) {
  const config = apnsConfiguration();
  if (!config) {
    throw new MobilePushProviderError(
      "APNs delivery credentials are not configured.",
      false,
      "configuration_required",
    );
  }
  const origin = input.environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  const client = connect(origin);
  const jwt = apnsJwt(config);
  const pushType = input.preview ? "alert" : "background";
  const body = JSON.stringify({
    aps: input.preview
      ? { alert: input.preview, sound: "default" }
      : { "content-available": 1 },
    asael: input.envelope,
  });
  return new Promise<{ messageId: string }>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      client.close();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new MobilePushProviderError(
        "APNs delivery timed out.",
        false,
        "transport_error",
      ));
    }, providerDeadlineMs);
    client.once("error", () => fail(new MobilePushProviderError(
      "APNs delivery failed.",
      false,
      "transport_error",
    )));
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${input.token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": config.bundleId,
      "apns-push-type": pushType,
      "apns-priority": input.preview ? "10" : "5",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    let status = 0;
    let apnsId = "";
    let responseBody = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      status = Number(headers[":status"] || 0);
      apnsId = String(headers["apns-id"] || "");
    });
    request.on("data", (chunk: string) => {
      if (responseBody.length < maxProviderResponseBytes) {
        responseBody += chunk.slice(0, maxProviderResponseBytes - responseBody.length);
      }
    });
    request.once("error", () => fail(new MobilePushProviderError(
      "APNs delivery failed.",
      false,
      "transport_error",
    )));
    request.on("end", () => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      client.close();
      if (status === 200 && apnsId) {
        resolve({ messageId: apnsId });
        return;
      }
      const reason = String(parseJson(responseBody).reason || `http_${status}`);
      reject(new MobilePushProviderError(
        `APNs rejected delivery (${reason}).`,
        status === 400 || status === 403 || status === 410,
        reason,
      ));
    });
    request.end(body);
  });
}

type FcmConfiguration = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

function fcmConfiguration(): FcmConfiguration | undefined {
  const raw = process.env.OMNIAGENT_FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const projectId = stringField(parsed.project_id, 6, 200);
    const clientEmail = stringField(parsed.client_email, 6, 320);
    const privateKey = normalizePrivateKey(parsed.private_key);
    return projectId && clientEmail && privateKey
      ? { projectId, clientEmail, privateKey }
      : undefined;
  } catch {
    return undefined;
  }
}

type ApnsConfiguration = {
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKey: string;
};

function apnsConfiguration(): ApnsConfiguration | undefined {
  const teamId = stringField(process.env.OMNIAGENT_APNS_TEAM_ID, 6, 20);
  const keyId = stringField(process.env.OMNIAGENT_APNS_KEY_ID, 6, 20);
  const bundleId = stringField(process.env.OMNIAGENT_APNS_BUNDLE_ID, 3, 200);
  const privateKey = normalizePrivateKey(process.env.OMNIAGENT_APNS_PRIVATE_KEY);
  return teamId && keyId && bundleId && privateKey
    ? { teamId, keyId, bundleId, privateKey }
    : undefined;
}

let cachedFcmToken: { binding: string; token: string; expiresAt: number } | undefined;

async function fcmAccessToken(config: FcmConfiguration) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const binding = `${config.projectId}:${config.clientEmail}`;
  if (
    cachedFcmToken?.binding === binding &&
    cachedFcmToken.expiresAt > nowSeconds + 60
  ) return cachedFcmToken.token;
  const assertion = signedJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: config.clientEmail,
      scope: oauthScope,
      aud: oauthAudience,
      iat: nowSeconds,
      exp: nowSeconds + 3_600,
    },
    config.privateKey,
    "RSA-SHA256",
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerDeadlineMs);
  try {
    const response = await fetch(oauthAudience, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: controller.signal,
    });
    const parsed = parseJson(await boundedResponseText(response));
    const token = typeof parsed.access_token === "string" ? parsed.access_token : "";
    const expiresIn = Number(parsed.expires_in || 0);
    if (!response.ok || !token || !Number.isFinite(expiresIn)) {
      throw new MobilePushProviderError(
        "FCM authorization failed.",
        false,
        "authorization_failed",
      );
    }
    cachedFcmToken = {
      binding,
      token,
      expiresAt: nowSeconds + Math.max(60, Math.min(expiresIn, 3_600)),
    };
    return token;
  } finally {
    clearTimeout(timeout);
  }
}

let cachedApnsJwt: { binding: string; token: string; issuedAt: number } | undefined;

function apnsJwt(config: ApnsConfiguration) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const binding = `${config.teamId}:${config.keyId}`;
  if (
    cachedApnsJwt?.binding === binding &&
    cachedApnsJwt.issuedAt > issuedAt - 2_700
  ) return cachedApnsJwt.token;
  const token = signedJwt(
    { alg: "ES256", kid: config.keyId },
    { iss: config.teamId, iat: issuedAt },
    config.privateKey,
    "SHA256",
    "ieee-p1363",
  );
  cachedApnsJwt = { binding, token, issuedAt };
  return token;
}

function signedJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: string,
  algorithm: string,
  dsaEncoding?: "der" | "ieee-p1363",
) {
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signer = createSign(algorithm);
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({ key: privateKey, dsaEncoding });
  return `${unsigned}.${signature.toString("base64url")}`;
}

function base64UrlJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function stringRecord(envelope: MobilePushEnvelope) {
  return Object.fromEntries(
    Object.entries(envelope)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

async function boundedResponseText(response: Response) {
  const text = await response.text();
  return text.slice(0, maxProviderResponseBytes);
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function nestedString(value: unknown, path: string[]) {
  let cursor = value;
  for (const segment of path) {
    if (Array.isArray(cursor)) cursor = cursor[Number(segment)];
    else if (cursor && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else return undefined;
  }
  return typeof cursor === "string" ? cursor : undefined;
}

function stringField(value: unknown, min: number, max: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= min && normalized.length <= max
    ? normalized
    : undefined;
}

function normalizePrivateKey(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\\n/g, "\n").trim();
  return normalized.includes("BEGIN PRIVATE KEY") && normalized.length <= 16_000
    ? normalized
    : undefined;
}
