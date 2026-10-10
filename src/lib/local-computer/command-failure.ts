/**
 * What the run is told when the installed Mac reports a failed, canceled, or
 * expired command. A failure the Mac explains says what already happened and
 * what to do next, since typing can stop partway through the text.
 */
export function localComputerCommandFailureMessage(code: string, platform: "macos" | "android" = "macos") {
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
      return (
        "The installed Mac did not click (click_target_covered): something else, " +
        "such as another window, a menu, or a dialog, was on top of the target. " +
        "Observe again before clicking."
      );
    default:
      return `The installed Mac did not complete the action (${code}).`;
  }
}
