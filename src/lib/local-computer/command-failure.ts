import { z } from "zod";

export const LOCAL_COMPUTER_CLICK_FAILURE_REASONS = {
  element_hit_test: [
    "expected_application_unavailable", "hit_query_failed", "hit_unavailable",
    "hit_outside_chosen_element", "hit_metadata_unavailable", "secure_hit_target",
  ],
  window_owner: [
    "window_expected_application_unavailable", "screen_coordinates_unavailable",
    "window_list_unavailable", "window_identity_unavailable", "window_bounds_unavailable",
    "window_owner_unavailable", "no_window_at_point", "covering_window", "mouse_routing_changed",
  ],
} as const;

/** Content-free native diagnostics. A parsed refusal never grants execution authority. */
export const localComputerNativeFailureSchema = z.discriminatedUnion("phase", [
  z.object({
    schemaVersion: z.literal(1), code: z.literal("click_target_covered"),
    phase: z.literal("element_hit_test"),
    reason: z.enum(LOCAL_COMPUTER_CLICK_FAILURE_REASONS.element_hit_test),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1), code: z.literal("click_target_covered"),
    phase: z.literal("window_owner"),
    reason: z.enum(LOCAL_COMPUTER_CLICK_FAILURE_REASONS.window_owner),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    code: z.enum(["stale_observation", "screenshot_coordinate_refused"]),
    phase: z.literal("observation_validation"),
    reason: z.enum(["stale_observation", "screenshot_coordinate_refused"]),
  }).strict().refine((value) => value.reason === value.code),
  z.object({
    schemaVersion: z.literal(1),
    code: z.enum(["task_authority_refused", "task_authority_unattested"]),
    phase: z.literal("task_authority"),
    reason: z.enum(["task_authority_refused", "task_authority_unattested"]),
  }).strict().refine((value) => value.reason === value.code),
]);
export type LocalComputerNativeFailure = z.infer<typeof localComputerNativeFailureSchema>;

const refusalCodes = [
  "click_target_covered", "stale_observation", "screenshot_coordinate_refused",
  "task_authority_refused", "task_authority_unattested", "typing_interrupted",
  "execution_indeterminate", "command_replay_refused", "unknown_refusal",
] as const;

export type LocalComputerFailureCode = typeof refusalCodes[number];
export type LocalComputerRecoveryAction =
  | "observe_then_semantic_action" | "observe_then_retarget"
  | "request_approval" | "observe_then_reconcile" | "stop";
export type LocalComputerFailureMetadata = Readonly<{
  schemaVersion: 1;
  code: LocalComputerFailureCode;
  phase: LocalComputerNativeFailure["phase"] | "unknown";
  reason: LocalComputerNativeFailure["reason"] | "not_reported";
  recovery: Readonly<{
    nextAction: LocalComputerRecoveryAction;
    observeBeforeAction: boolean;
    automaticReplayAllowed: false;
    maximumSameTargetRefusals: 2;
    guidance: string;
  }>;
}>;

/** Missing/invalid diagnostics never manufacture a native phase or reason. */
export function localComputerFailureMetadata(
  code: string,
  nativeFailure?: unknown,
): LocalComputerFailureMetadata {
  const parsed = localComputerNativeFailureSchema.safeParse(nativeFailure);
  const native = parsed.success && parsed.data.code === code ? parsed.data : undefined;
  const safeCode = refusalCodes.includes(code as LocalComputerFailureCode)
    ? code as LocalComputerFailureCode : "unknown_refusal";
  let nextAction: LocalComputerRecoveryAction = "stop";
  let guidance = "Stop this action and report the refusal. Its effect is unknown; do not automatically replay it or claim completion.";
  if (native?.reason === "secure_hit_target") {
    guidance = "The hit target is a secure control. Stop this input action and report the protected target; do not use another tool or coordinate to bypass it.";
  } else if (safeCode === "task_authority_refused" || safeCode === "task_authority_unattested") {
    nextAction = "request_approval";
    guidance = "The device did not accept task authority for this action. Use the governed approval path for this exact action; do not change its declared purpose or retry it to avoid review.";
  } else if (safeCode === "click_target_covered" && native?.phase === "element_hit_test") {
    nextAction = "observe_then_semantic_action";
    guidance = "The click target could not be verified by Accessibility hit testing. Observe again. If the requested control exposes a supported semantic Press action, prefer that governed action; otherwise select a newly verified target. Do not repeat the unchanged click.";
  } else if (["click_target_covered", "stale_observation", "screenshot_coordinate_refused"].includes(safeCode)) {
    nextAction = "observe_then_retarget";
    guidance = safeCode === "click_target_covered" && native?.phase === "window_owner"
      ? "The click could not be routed to the observed application. Observe again and resolve the actual covering window or unavailable routing evidence before selecting a target. Do not repeat the unchanged click."
      : "The selected target was not verified. Observe again and use the new snapshot and a verified target. Do not reuse the refused snapshot or repeat an unchanged failing target.";
  } else if (["typing_interrupted", "execution_indeterminate", "command_replay_refused"].includes(safeCode)) {
    nextAction = "observe_then_reconcile";
    guidance = "Part of the action may already have happened. Observe and reconcile the actual state before deciding what remains. Do not automatically replay the action.";
  }
  return {
    schemaVersion: 1, code: safeCode,
    phase: native?.phase ?? "unknown", reason: native?.reason ?? "not_reported",
    recovery: {
      nextAction, observeBeforeAction: nextAction.startsWith("observe_"),
      automaticReplayAllowed: false, maximumSameTargetRefusals: 2, guidance,
    },
  };
}

/** Rebuild guidance locally; never trust guidance supplied by a device or tool output. */
export function readLocalComputerFailureMetadata(value: unknown): LocalComputerFailureMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.code !== "string" ||
      !refusalCodes.includes(raw.code as LocalComputerFailureCode)) return undefined;
  return localComputerFailureMetadata(raw.code, {
    schemaVersion: raw.schemaVersion, code: raw.code, phase: raw.phase, reason: raw.reason,
  });
}

/**
 * What the run is told when the installed Mac reports a failed, canceled, or
 * expired command. A failure the Mac explains says what already happened and
 * what to do next, since typing can stop partway through the text.
 */
export function localComputerCommandFailureMessage(
  code: string,
  platform: "macos" | "android" = "macos",
  nativeFailure?: unknown,
) {
  if (platform === "android") {
    switch (code) {
      case "native_upgrade_required": return "Update the Asael phone app before using phone control. This action was not sent.";
      case "device_locked": return "Unlock your phone and start phone control again.";
      case "snapshot_stale": return "The phone screen changed. Observe the current screen before another action.";
      case "restricted_target": return "This screen or control is protected. Complete that step yourself, then return to a supported app.";
      case "screen_unavailable": return "The phone screen is unavailable. Open the requested app and observe it again.";
      case "app_unavailable": return "That app could not be opened on this phone. Check that it is installed and enabled.";
      case "foreground_service_unavailable": return "Return to Asael and start the phone session again.";
      case "execution_indeterminate":
      case "command_replay_refused": return "The phone action may already have happened. Observe the current screen; this action will not be replayed automatically.";
      case "stopped":
      case "device_stopped": return "Phone control has stopped. Start it again in Asael to continue.";
      default: return `The phone did not complete the action (${code}).`;
    }
  }
  switch (code) {
    case "native_upgrade_required":
      return "Update the Asael Mac app to use this action. It was not sent to the older app.";
    case "application_open_failed":
      return "macOS could not open that app. Check that it is installed and can open normally; ATLAS has not accepted any permission prompt.";
    case "typing_interrupted":
      return (
        "The installed Mac stopped typing partway (typing_interrupted): the field " +
        "lost focus, so part of the text may already be typed. Observe before " +
        "typing again."
      );
    case "click_target_covered":
      return "The installed Mac did not click (click_target_covered). " +
        localComputerFailureMetadata(code, nativeFailure).recovery.guidance;
    case "stale_observation":
    case "screenshot_coordinate_refused":
    case "task_authority_refused":
    case "task_authority_unattested":
      return `The installed Mac did not complete the action (${code}). ` +
        localComputerFailureMetadata(code, nativeFailure).recovery.guidance;
    default:
      return `The installed Mac did not complete the action (${code}).`;
  }
}
