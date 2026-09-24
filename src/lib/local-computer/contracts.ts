import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { z } from "zod";

export const LOCAL_COMPUTER_PROTOCOL_VERSION = 1 as const;
export const LOCAL_COMPUTER_NATIVE_CONTRACT_VERSION = 11 as const;
export const LOCAL_COMPUTER_PRESENT_SCREENSHOT_CONTRACT_VERSION = 12 as const;
export const LOCAL_COMPUTER_OPEN_URL_CONTRACT_VERSION = 13 as const;
export const LOCAL_COMPUTER_SCREENSHOT_COORDINATE_CONTRACT_VERSION = 13 as const;
export const LOCAL_COMPUTER_COMMAND_RUNNER_CONTRACT_VERSION = 27 as const;
export const LOCAL_COMPUTER_DEVICE_LEASE_SECONDS = 24;
export const LOCAL_COMPUTER_COMMAND_LEASE_SECONDS = 30;
export const LOCAL_COMPUTER_COMMAND_TIMEOUT_MS = 45_000;
export const LOCAL_COMPUTER_MAX_SCREENSHOT_BYTES = 1_300_000;
export const LOCAL_COMPUTER_MAX_TERMINAL_OUTPUT_BYTES = 32 * 1_024;
export const LOCAL_COMPUTER_MAX_TERMINAL_STREAM_BYTES = 4 * 1_024 * 1_024;

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
  "run_command",
]);
export type LocalComputerAction = z.infer<typeof localComputerActionSchema>;

const permissionState = z.enum(["granted", "denied", "unknown"]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const commandWorkspaceId = z.string()
  .regex(/^local_workspace_[a-f0-9]{32}$/);
const semanticVersion = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);

export const localComputerCommandRunnerSchema = z.object({
  helperInstalled: z.boolean(),
  helperVersion: semanticVersion,
  workspaces: z.array(z.object({
    id: commandWorkspaceId,
    name: z.string().trim().min(1).max(120)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
  }).strict()).max(32),
}).strict().superRefine((value, context) => {
  if (!value.helperInstalled && value.workspaces.length) {
    context.addIssue({
      code: "custom",
      path: ["workspaces"],
      message: "A missing command helper cannot advertise workspaces.",
    });
  }
  if (new Set(value.workspaces.map((workspace) => workspace.id)).size !==
    value.workspaces.length) {
    context.addIssue({
      code: "custom",
      path: ["workspaces"],
      message: "Command workspace IDs must be unique.",
    });
  }
});

export const localComputerDeviceUpdateSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  enabled: z.boolean(),
  helperVersion: semanticVersion,
  permissions: z.object({
    accessibility: permissionState,
    screenRecording: permissionState,
  }).strict(),
  activityState: z.enum(["idle", "active", "stopped", "error"]),
  commandRunner: localComputerCommandRunnerSchema.optional(),
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
        parsed.password ||
        !isPublicBrowserHost(parsed.hostname)
      ) {
        context.addIssue({
          code: "custom",
          message: "The browser URL is not permitted.",
        });
      }
    }),
  loadWaitSeconds: z.number().int().min(0).max(15).optional(),
  presentScreenshot: z.boolean().default(false),
}).strict();

/**
 * Browser navigation may target public DNS names or globally routable IP
 * literals. Localhost and non-public literals fail closed before the command
 * can reach the native helper. DNS resolution is intentionally not performed
 * here; the helper repeats the literal-host check at the effect boundary.
 */
export function isPublicBrowserHost(rawHostname: string): boolean {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    return false;
  }
  const version = isIP(hostname);
  if (version === 4) return isGloballyRoutableIpv4(hostname);
  if (version === 6) return isGloballyRoutableIpv6(hostname);
  return true;
}

function isGloballyRoutableIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) =>
    !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [first, second, third] = octets;
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  ) {
    return false;
  }
  return true;
}

function isGloballyRoutableIpv6(hostname: string): boolean {
  const bytes = ipv6Bytes(hostname);
  if (!bytes) return false;
  // Public IPv6 unicast is currently 2000::/3. Exclude documentation,
  // deprecated transition, and special-purpose sub-ranges inside that block.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01) {
    if ((bytes[2] & 0xfe) === 0) return false; // 2001:0000::/23
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return false; // documentation
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // deprecated 6to4
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) {
    return false; // 3fff::/20 documentation
  }
  return true;
}

function ipv6Bytes(hostname: string): number[] | undefined {
  const halves = hostname.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (value: string) => value
    ? value.split(":").map((part) => Number.parseInt(part, 16))
    : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || "");
  if (
    [...left, ...right].some((value) =>
      !Number.isInteger(value) || value < 0 || value > 0xffff) ||
    (halves.length === 1 && left.length !== 8) ||
    left.length + right.length >= 8
  ) {
    return undefined;
  }
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left;
  if (groups.length !== 8) return undefined;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

export const localComputerInteractionPurposeSchema = z.enum([
  "navigation",
  "selection",
  "media_control",
  "submit",
  "file_transfer",
  "destructive",
  "financial",
  "account_security",
  "permission_change",
  "unknown",
]);

export const localComputerClickInputSchema = z.union([
  z.object({
    snapshotRevision: sha256,
    elementId: z.string().min(3).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
    interactionPurpose: localComputerInteractionPurposeSchema,
  }).strict(),
  z.object({
    snapshotRevision: sha256,
    coordinateSpace: z.literal("screenshot_pixel"),
    x: z.number().finite().min(0).max(32_768),
    y: z.number().finite().min(0).max(32_768),
    interactionPurpose: localComputerInteractionPurposeSchema,
  }).strict(),
]);

// The governed tool input above must carry purpose so policy can decide
// whether one task-scoped grant applies. Purpose is deliberately stripped
// before the command crosses the native courier boundary; the helper receives
// only the exact click target. Keep that wire contract separate so validating
// a claimed command cannot reject the intentionally minimized payload after
// the database claim has already been acquired.
const localComputerHelperClickInputSchema = z.union([
  z.object({
    snapshotRevision: sha256,
    elementId: z.string().min(3).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  }).strict(),
  z.object({
    snapshotRevision: sha256,
    coordinateSpace: z.literal("screenshot_pixel"),
    x: z.number().finite().min(0).max(32_768),
    y: z.number().finite().min(0).max(32_768),
  }).strict(),
]);

const commandExecutableDenylist = new Set([
  "ash",
  "bash",
  "csh",
  "dash",
  "env",
  "exec",
  "fish",
  "ksh",
  "launchctl",
  "login",
  "nohup",
  "open",
  "osascript",
  "script",
  "security",
  "sh",
  "sudo",
  "tcsh",
  "time",
  "xargs",
  "zsh",
]);
const commandArgument = z.string().max(8_192).superRefine((value, context) => {
  if (
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > 8_192
  ) {
    context.addIssue({
      code: "custom",
      message: "A command argument contains a control character or exceeds 8 KiB.",
    });
  }
});

export const localComputerRunCommandInputSchema = z.object({
  workspaceId: commandWorkspaceId,
  executable: z.string().trim().min(1).max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/)
    .superRefine((value, context) => {
      if (commandExecutableDenylist.has(value.toLowerCase())) {
        context.addIssue({
          code: "custom",
          message: "Shells and security-sensitive command launchers are not permitted.",
        });
      }
    }),
  arguments: z.array(commandArgument).max(64),
  relativeDirectory: z.string().trim().min(1).max(1_024)
    .superRefine((value, context) => {
      const segments = value.split("/");
      if (
        (value !== "." && segments.some((segment) =>
          !segment || segment === "." || segment === "..")) ||
        value.startsWith("/") ||
        value.startsWith("~") ||
        value.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(value)
      ) {
        context.addIssue({
          code: "custom",
          message: "The command directory must stay inside the selected workspace.",
        });
      }
    }),
  timeoutSeconds: z.number().int().min(1).max(30),
}).strict().superRefine((value, context) => {
  if (
    value.arguments.reduce(
      (total, argument) => total + Buffer.byteLength(argument, "utf8"),
      0,
    ) > 49_152
  ) {
    context.addIssue({
      code: "custom",
      path: ["arguments"],
      message: "The combined command arguments exceed 48 KiB.",
    });
  }
});

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
  if (
    value.action === "click" &&
    !localComputerHelperClickInputSchema.safeParse(value.input).success
  ) {
    context.addIssue({
      code: "custom",
      path: ["input"],
      message: "The local computer click input is invalid or ambiguous.",
    });
  }
  if (
    value.action === "run_command" &&
    !localComputerRunCommandInputSchema.safeParse(value.input).success
  ) {
    context.addIssue({
      code: "custom",
      path: ["input"],
      message: "The governed local command input is invalid or unsafe.",
    });
  }
});

const frontmostApplicationSchema = z.object({
  name: z.string().trim().min(1).max(240),
  bundleId: z.string().trim().min(1).max(240).nullable().optional(),
  pid: z.number().int().positive().max(2_147_483_647),
}).strict();

const logicalCoordinate = z.number().finite().min(-131_072).max(131_072);
const logicalDimension = z.number().finite().positive().max(131_072);
const logicalRectangleSchema = z.object({
  x: logicalCoordinate,
  y: logicalCoordinate,
  width: logicalDimension,
  height: logicalDimension,
}).strict();
const screenshotDimension = z.number().int().positive().max(32_768);
const screenshotCoordinateContractSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotRevision: sha256,
  capturedAt: z.string().datetime({ offset: true }),
  screenshotOrigin: z.literal("top_left"),
  targetSpace: z.literal("macos_global_logical_top_left"),
  display: z.object({
    id: z.number().int().positive().max(4_294_967_295),
    logicalBounds: logicalRectangleSchema,
  }).strict(),
  logicalPointsPerPixel: z.object({
    x: z.number().finite().positive().max(64),
    y: z.number().finite().positive().max(64),
  }).strict(),
  quality: z.object({
    degradation: z.enum(["jpeg_compressed", "downscaled_jpeg"]),
    occlusion: z.enum(["not_assessed", "possible", "none_detected"]),
  }).strict(),
  target: z.object({
    pid: z.number().int().positive().max(2_147_483_647),
    bundleId: z.string().trim().min(1).max(240).optional(),
    window: z.object({
      identitySha256: sha256,
      logicalBounds: logicalRectangleSchema.optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

const screenshotSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  dataBase64: z.string().min(4).max(1_733_336),
  widthPixels: screenshotDimension.optional(),
  heightPixels: screenshotDimension.optional(),
  coordinateSpace: z.literal("screenshot_pixel").optional(),
  coordinateContract: screenshotCoordinateContractSchema.optional(),
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
  const coordinateFields = [
    value.widthPixels,
    value.heightPixels,
    value.coordinateSpace,
    value.coordinateContract,
  ];
  const hasCoordinateMetadata = coordinateFields.some(
    (field) => field !== undefined,
  );
  if (
    hasCoordinateMetadata &&
    coordinateFields.some((field) => field === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "The screenshot coordinate contract is incomplete.",
    });
  }
  if (
    value.widthPixels && value.heightPixels && value.coordinateContract
  ) {
    const { logicalBounds } = value.coordinateContract.display;
    const expectedX = logicalBounds.width / value.widthPixels;
    const expectedY = logicalBounds.height / value.heightPixels;
    const actual = value.coordinateContract.logicalPointsPerPixel;
    const closeEnough = (left: number, right: number) =>
      Math.abs(left - right) <= Number.EPSILON * 64 * Math.max(1, left, right);
    if (!closeEnough(expectedX, actual.x) || !closeEnough(expectedY, actual.y)) {
      context.addIssue({
        code: "custom",
        path: ["coordinateContract", "logicalPointsPerPixel"],
        message: "The screenshot coordinate mapping is inconsistent.",
      });
    }
  }
});

const terminalDisplayText = z.string().max(
  LOCAL_COMPUTER_MAX_TERMINAL_OUTPUT_BYTES,
).superRefine((value, context) => {
  if (
    Buffer.byteLength(value, "utf8") > LOCAL_COMPUTER_MAX_TERMINAL_OUTPUT_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "Retained terminal output exceeds 32 KiB.",
    });
  }
});

export const localComputerTerminalOutputSchema = z.object({
  stdout: terminalDisplayText,
  stderr: terminalDisplayText,
  exitCode: z.number().int().min(-1).max(255),
  durationMs: z.number().int().min(0).max(LOCAL_COMPUTER_COMMAND_TIMEOUT_MS),
  stdoutBytes: z.number().int().min(0).max(
    LOCAL_COMPUTER_MAX_TERMINAL_STREAM_BYTES,
  ),
  stderrBytes: z.number().int().min(0).max(
    LOCAL_COMPUTER_MAX_TERMINAL_STREAM_BYTES,
  ),
  stdoutSha256: sha256,
  stderrSha256: sha256,
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
}).strict();

export const localComputerResultSchema = z.object({
  summary: z.string().trim().min(1).max(1_000),
  data: z.record(z.string(), z.unknown()).optional(),
  terminalOutput: localComputerTerminalOutputSchema.optional(),
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
  if (value.terminalOutput) {
    const output = value.terminalOutput;
    const data = value.data || {};
    const mirroredFields = [
      "exitCode",
      "durationMs",
      "stdoutBytes",
      "stderrBytes",
      "stdoutSha256",
      "stderrSha256",
      "stdoutTruncated",
      "stderrTruncated",
    ] as const;
    if (
      data.effectVerdict !== "confirmed" ||
      mirroredFields.some((field) => data[field] !== output[field])
    ) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message:
          "Terminal result metadata must mirror the ephemeral output and confirm process execution.",
      });
    }
  }
  if (value.terminalOutput && value.observation) {
    context.addIssue({
      code: "custom",
      message: "A local result cannot mix terminal output with a visual observation.",
    });
  }
  const observation = value.observation;
  const screenshotRevision = observation?.screenshot?.coordinateContract
    ?.snapshotRevision;
  if (
    screenshotRevision !== undefined &&
    screenshotRevision !== observation?.snapshotRevision
  ) {
    context.addIssue({
      code: "custom",
      path: ["observation", "screenshot", "coordinateContract", "snapshotRevision"],
      message: "The screenshot is not bound to the enclosing snapshot.",
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
