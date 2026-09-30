/**
 * What the run is told when the installed Mac reports a failed, canceled, or
 * expired command. A failure the Mac explains says what already happened and
 * what to do next, since typing can stop partway through the text.
 */
export function localComputerCommandFailureMessage(code: string) {
  switch (code) {
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
