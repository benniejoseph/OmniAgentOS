import { Buffer } from "node:buffer";
import { z } from "zod";

export const LOCAL_COMPUTER_PROTOCOL_VERSION = 1 as const;
export const LOCAL_COMPUTER_NATIVE_CONTRACT_VERSION = 11 as const;
export const LOCAL_COMPUTER_OPEN_URL_CONTRACT_VERSION = 12 as const;
export const LOCAL_COMPUTER_DEVICE_LEASE_SECONDS = 24;
export const LOCAL_COMPUTER_COMMAND_LEASE_SECONDS = 30;
export const LOCAL_COMPUTER_COMMAND_TIMEOUT_MS = 45_000;
export const LOCAL_COMPUTER_MAX_SCREENSHOT_BYTES = 1_300_000;

export const localComputerActionSchema = z.enum([
  "observe",
  "list_apps",
  "activate_app",
  "open_url",
  "press",
  "click",
  "type",
  "key",
  "scroll",
]);
export type LocalComputerAction = z.infer<typeof localComputerActionSchema>;

const permissionState = z.enum(["granted", "denied", "unknown"]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const localComputerDeviceUpdateSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  enabled: z.boolean(),
  helperVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  permissions: z.object({
    accessibility: permissionState,
    screenRecording: permissionState,
  }).strict(),
  activityState: z.enum(["idle", "active", "stopped", "error"]),
}).strict();

export const localComputerClaimRequestSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  waitSeconds: z.number().int().min(0).max(20).optional(),
}).strict();

export const localComputerOpenUrlInputSchema = z.object({
  browser: z.literal("chrome"),
  url: z.string().min(8).max(4_096)
    .regex(/^https?:\/\/[^\u0000-\u0020\u007f\\]+$/)
    .superRefine((value, context) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        context.addIssue({
          code: "custom",
          message: "The browser URL must be an absolute HTTP or HTTPS URL.",
        });
        return;
      }
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
      ) {
        context.addIssue({
          code: "custom",
          message: "The browser URL is not permitted.",
        });
      }
    }),
  loadWaitSeconds: z.number().int().min(0).max(15).optional(),
}).strict();

export const localComputerCommandSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  id: z.string().regex(/^local_computer_command_[a-f0-9]{48}$/),
  runId: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/),
  executionId: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/),
  action: localComputerActionSchema,
  input: z.record(z.string(), z.unknown()),
  presentScreenshot: z.boolean(),
  claimToken: z.string().min(32).max(256),
  claimGeneration: z.number().int().positive(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (
    value.action === "open_url" &&
    !localComputerOpenUrlInputSchema.safeParse(value.input).success
  ) {
    context.addIssue({
      code: "custom",
      path: ["input"],
      message: "The browser navigation input is invalid.",
    });
  }
});

const frontmostApplicationSchema = z.object({
  name: z.string().trim().min(1).max(240),
  bundleId: z.string().trim().min(1).max(240).nullable().optional(),
  pid: z.number().int().positive().max(2_147_483_647),
}).strict();

const screenshotSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  dataBase64: z.string().min(4).max(1_733_336),
}).strict().superRefine((value, context) => {
  const bytes = Buffer.from(value.dataBase64, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/g, "");
  if (
    !bytes.byteLength ||
    bytes.byteLength > LOCAL_COMPUTER_MAX_SCREENSHOT_BYTES ||
    canonical !== value.dataBase64.replace(/=+$/g, "") ||
    !imageSignatureMatches(bytes, value.mimeType)
  ) {
    context.addIssue({
      code: "custom",
      message: "The local computer screenshot is invalid or too large.",
    });
  }
});

export const localComputerResultSchema = z.object({
  summary: z.string().trim().min(1).max(1_000),
  data: z.record(z.string(), z.unknown()).optional(),
  observation: z.object({
    snapshotRevision: sha256,
    frontmostApplication: frontmostApplicationSchema.optional(),
    accessibilitySnapshot: z.string().trim().min(1).max(160_000).optional(),
    screenshot: screenshotSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  const effectVerdict = value.data?.effectVerdict;
  if (
    effectVerdict !== undefined &&
    (typeof effectVerdict !== "string" ||
      !["confirmed", "suspected_noop", "unverifiable"].includes(
        effectVerdict,
      ))
  ) {
    context.addIssue({
      code: "custom",
      path: ["data", "effectVerdict"],
      message: "The local computer effect verdict is invalid.",
    });
  }
  if (Buffer.byteLength(JSON.stringify(value.data || {}), "utf8") > 160_000) {
    context.addIssue({
      code: "custom",
      path: ["data"],
      message: "The local computer result metadata is too large.",
    });
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 2_000_000) {
    context.addIssue({
      code: "custom",
      message: "The combined local computer result is too large.",
    });
  }
});

export const localComputerCompletionRequestSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  claimToken: z.string().min(32).max(256),
  outcome: z.enum(["succeeded", "failed", "canceled"]),
  result: localComputerResultSchema.optional(),
  errorCode: z.string().trim().min(1).max(160).regex(/^[a-z0-9._:-]+$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "succeeded" && !value.result) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "A successful local computer command requires a result.",
    });
  }
  if (value.outcome !== "succeeded" && !value.errorCode) {
    context.addIssue({
      code: "custom",
      path: ["errorCode"],
      message: "A failed local computer command requires an error code.",
    });
  }
});

export const localComputerStopRequestSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  reason: z.enum(["user_stop", "app_exit", "sign_out", "permission_lost"]),
}).strict();

export type LocalComputerDeviceUpdate = z.infer<
  typeof localComputerDeviceUpdateSchema
>;
export type LocalComputerCompletionRequest = z.infer<
  typeof localComputerCompletionRequestSchema
>;

function imageSignatureMatches(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 &&
      bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8;
  }
  return bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 &&
    bytes[10] === 0x42 && bytes[11] === 0x50;
}
