import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { localComputerCommandFailureMessage } from "@/lib/local-computer/command-failure";

const helperFile = "apps/flutter/macos/ComputerUseHelper/HelperMain.swift";

// The window and ancestor rules are covered by the Mac helper's
// InputDeliveryPolicy suite. Hit tests and focus reads need a signed-in Mac,
// so this checks that each click and each typed chunk still consults them.
describe("This Mac input delivery gates", () => {
  it("clicks only when the target is on top", async () => {
    const helper = await readFile(helperFile, "utf8");

    const elementCheck =
      "      try withBoundedAccessibilityMessaging {\n" +
      "        guard let target = clickTarget(inside: expectedElement, at: point) else {\n" +
      "          throw HelperFailure.rejected(Self.clickTargetCovered)\n" +
      "        }\n" +
      "        if taskAuthority { try requireTaskAuthorityPointerTarget(target) }\n" +
      "      }\n" +
      "    }\n";
    const windowCheck =
      "    guard clickReachesObservedApplication(at: point) else {\n" +
      "      throw HelperFailure.rejected(Self.clickTargetCovered)\n" +
      "    }\n" +
      "    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,";
    expect(helper).toContain(elementCheck);
    expect(helper).toContain(windowCheck);
    const elementClick = helper.indexOf("    if requiresSnapshotElementVerification {\n");
    expect(elementClick).toBeGreaterThan(-1);
    expect(elementClick).toBeLessThan(helper.indexOf(elementCheck));
    expect(helper.indexOf(elementCheck)).toBeLessThan(helper.indexOf(windowCheck));
    expect(helper.match(/CGEvent\(mouseEventSource:/g)).toHaveLength(2);
    expect(helper).not.toContain("guard let target = currentObservedHitTarget(at: point) else {");

    for (const rule of [
      "guard AXUIElementCopyElementAtPosition(\n" +
        "            AXUIElementCreateApplication(expectedPID),\n" +
        "            Float(point.x),\n" +
        "            Float(point.y),\n" +
        "            &hitElement\n" +
        "          ) == .success,\n" +
        "          let hitElement,\n" +
        "          InputDeliveryPolicy.isWithin(\n" +
        "            hitElement,\n" +
        "            chosen: element,\n" +
        "            limit: Self.maximumHitTargetAncestorDepth,\n" +
        "            parent: { self.axElementAttribute($0, kAXParentAttribute as String) },\n" +
        "            same: { CFEqual($0, $1) }\n" +
        "          ),\n" +
        "          let identity = screenshotHitTargetMetadata(hitElement)?.identity,\n" +
        "          !isSecure(role: identity.role, subrole: identity.subrole)\n" +
        "    else { return nil }\n" +
        "    return hitElement\n",
      "let windows = CGWindowListCopyWindowInfo(\n" +
        "            [.optionOnScreenOnly, .excludeDesktopElements],\n" +
        "            kCGNullWindowID\n" +
        "          ) as? [[String: Any]]\n" +
        "    else { return false }\n" +
        "    return InputDeliveryPolicy.windowOwner(at: point, windows: windows) == expectedPID\n",
    ]) {
      expect(helper).toContain(rule);
    }
  });

  it("checks the field before each typed chunk after the first", async () => {
    const helper = await readFile(helperFile, "utf8");

    const loop = helper.indexOf("    while offset < units.count {\n      if offset > 0 {\n");
    const check =
      "        try? await Task.sleep(nanoseconds: Self.typingChunkPauseNanoseconds)\n" +
      "        let fieldHasFocus = (try? withBoundedAccessibilityMessaging {\n" +
      "          typingTargetIsCurrent(focusTarget.element)\n" +
      "        }) ?? false\n" +
      "        guard fieldHasFocus else " +
      "{ throw HelperFailure.rejected(Self.typingInterrupted) }\n" +
      "      }\n" +
      "      let chunk = Array(units[offset..<min(offset + 20, units.count)])\n";
    expect(loop).toBeGreaterThan(-1);
    expect(helper.indexOf(check)).toBeGreaterThan(loop);
    expect(helper.indexOf(check) - loop).toBeLessThan(400);
    expect(helper).toContain(
      "    guard !IsSecureEventInputEnabled(),\n" +
        "          captureTargetIsCurrent(),\n" +
        "          let expectedPID = snapshotFrontmostPID,\n" +
        "          let focused = axElementAttribute(\n" +
        "            AXUIElementCreateApplication(expectedPID),\n" +
        "            kAXFocusedUIElementAttribute as String\n" +
        "          )\n" +
        "    else { return false }\n" +
        "    return CFEqual(focused, field)\n",
    );
    expect(helper).toContain(
      "private static let typingChunkPauseNanoseconds: UInt64 = 10_000_000\n",
    );
  });

  it("reports each refusal under the code the run is told about", async () => {
    const helper = await readFile(helperFile, "utf8");

    for (const [name, code] of [
      ["clickTargetCovered", "click_target_covered"],
      ["typingInterrupted", "typing_interrupted"],
    ]) {
      expect(helper).toContain(`private static let ${name} = "${code}"\n`);
      expect(localComputerCommandFailureMessage(code)).toContain(`(${code})`);
      expect(localComputerCommandFailureMessage(code)).not.toContain("did not complete");
    }
  });
});
