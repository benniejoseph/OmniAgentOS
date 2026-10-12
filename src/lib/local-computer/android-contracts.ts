import { z } from "zod";
import { localComputerInteractionPurposeSchema } from "@/lib/local-computer/contracts";

export const LOCAL_ANDROID_NATIVE_CONTRACT_VERSION = 53;
export const localAndroidActionSchema = z.enum([
  "observe", "list_apps", "open_app", "press", "tap", "type", "scroll", "swipe", "back", "home",
]);
export type LocalAndroidAction = z.infer<typeof localAndroidActionSchema>;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const elementId = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const pixel = z.number().finite().min(0).max(32_768);
const packageName = z.string().min(3).max(240).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/);
const snapshot = { snapshotRevision: revision };
const purpose = { interactionPurpose: localComputerInteractionPurposeSchema };
export const localAndroidInputs = {
  observe: z.object({ presentScreenshot: z.boolean().optional() }).strict(),
  list_apps: z.object({ query: z.string().trim().max(120).optional(), includeInstalled: z.boolean().optional() }).strict(),
  open_app: z.object({ packageName }).strict(),
  press: z.object({ ...snapshot, elementId, ...purpose }).strict(),
  tap: z.object({ ...snapshot, coordinateSpace: z.literal("screenshot_pixel"), x: pixel, y: pixel, ...purpose }).strict(),
  type: z.object({ ...snapshot, elementId, text: z.string().min(1).max(8_000), ...purpose }).strict(),
  scroll: z.object({ ...snapshot, elementId, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(5).optional(), ...purpose }).strict(),
  swipe: z.object({ ...snapshot, coordinateSpace: z.literal("screenshot_pixel"), startX: pixel, startY: pixel, endX: pixel, endY: pixel, durationMs: z.number().int().min(100).max(1_000), ...purpose }).strict(),
  back: z.object({ ...snapshot, ...purpose }).strict(),
  home: z.object({ snapshotRevision: revision.optional(), ...purpose }).strict(),
} as const;
export const LOCAL_ANDROID_TASK_AUTHORITY_ACTIONS: ReadonlySet<string> = new Set([
  "open_app", "press", "tap", "type", "scroll", "swipe", "back", "home",
]);
export const localAndroidDeviceUpdateSchema = z.object({
  schemaVersion: z.literal(1), enabled: z.boolean(),
  helperVersion: z.string().regex(/^\d+\.\d+\.\d+$/).max(64),
  permissions: z.object({
    accessibility: z.enum(["granted", "denied", "unknown"]),
    screenCapture: z.enum(["granted", "unavailable", "unknown"]),
  }).strict(),
  activityState: z.enum(["idle", "active", "stopped", "error"]),
  supported: z.boolean(), locked: z.boolean(), foregroundServiceReady: z.boolean(),
  androidApiLevel: z.number().int().min(1).max(100),
}).strict();
export type LocalAndroidDeviceUpdate = z.infer<typeof localAndroidDeviceUpdateSchema>;
const rectangle = z.object({ x: pixel, y: pixel, width: pixel, height: pixel }).strict();
export const localAndroidObservationSchema = z.object({
  capturedAt: z.string().datetime({ offset: true }), snapshotRevision: revision,
  frontmostApplication: z.object({ name: z.string().min(1).max(240), packageName }).strict(),
  window: z.object({ id: z.number().int(), displayId: z.number().int().min(0), bounds: rectangle }).strict(),
  elements: z.array(z.object({
    id: elementId, role: z.string().max(160), label: z.string().max(2_000), value: z.string().max(4_000).optional(),
    bounds: rectangle, enabled: z.boolean(), editable: z.boolean(), clickable: z.boolean(), scrollable: z.boolean(),
  }).strict()).max(400),
  accessibilitySnapshot: z.string().max(160_000).optional(),
  screenshot: z.object({
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    dataBase64: z.string().min(4).max(1_733_336).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    widthPixels: z.number().int().positive().max(32_768), heightPixels: z.number().int().positive().max(32_768),
    coordinateSpace: z.literal("screenshot_pixel"),
  }).strict().optional(),
}).strict();
export const localAndroidResultSchema = z.object({
  summary: z.string().trim().min(1).max(1_000),
  data: z.record(z.string(), z.unknown()).optional(),
  observation: localAndroidObservationSchema.optional(),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 2_000_000 || (value.data && Buffer.byteLength(JSON.stringify(value.data), "utf8") > 160_000)) {
    context.addIssue({ code: "custom", message: "The phone result exceeds the bounded response size." });
  }
  if (value.data?.effectVerdict !== undefined && !["confirmed", "suspected_noop", "unverifiable"].includes(String(value.data.effectVerdict))) {
    context.addIssue({ code: "custom", message: "The phone effect verdict is invalid." });
  }
  const screenshot = value.observation?.screenshot;
  if (screenshot) {
    const bytes = Buffer.from(screenshot.dataBase64, "base64");
    const signatureValid = screenshot.mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : screenshot.mimeType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP";
    if (bytes.length > 1_300_000 || !signatureValid) context.addIssue({ code: "custom", message: "The phone screenshot is invalid." });
  }
});
export const localAndroidCommandSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^local_computer_command_[a-f0-9]{48}$/),
  runId: z.string().min(1).max(240), executionId: z.string().min(1).max(240),
  action: localAndroidActionSchema, input: z.record(z.string(), z.unknown()), presentScreenshot: z.boolean(),
  claimToken: z.string().min(32).max(256), claimGeneration: z.number().int().positive(),
  expiresAt: z.string().datetime({ offset: true }), authority: z.literal("task").optional(),
}).strict().superRefine((value, context) => {
  const input = value.action === "observe" ? value.input :
    value.action !== "list_apps" && value.action !== "open_app" ? { ...value.input, interactionPurpose: "unknown" } : value.input;
  if (!localAndroidInputs[value.action].safeParse(input).success) context.addIssue({ code: "custom", path: ["input"], message: "Invalid bounded Android action." });
  if (value.authority && !LOCAL_ANDROID_TASK_AUTHORITY_ACTIONS.has(value.action)) context.addIssue({ code: "custom", path: ["authority"], message: "This phone action cannot carry task authority." });
});
export const localAndroidCompletionRequestSchema = z.object({
  schemaVersion: z.literal(1), claimToken: z.string().min(32).max(256),
  outcome: z.enum(["succeeded", "failed", "canceled"]), result: localAndroidResultSchema.optional(),
  errorCode: z.string().trim().min(1).max(160).regex(/^[a-z0-9._:-]+$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "succeeded" ? !value.result : !value.errorCode) context.addIssue({ code: "custom", message: "A phone completion needs its result or failure reason." });
});
export type LocalAndroidCompletionRequest = z.infer<typeof localAndroidCompletionRequestSchema>;
