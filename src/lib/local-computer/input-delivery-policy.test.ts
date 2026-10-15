import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { localComputerCommandFailureMessage } from "@/lib/local-computer/command-failure";

const helperFile = "apps/flutter/macos/ComputerUseHelper/HelperMain.swift";

// The window and ancestor rules are covered by the Mac helper's
// InputDeliveryPolicy suite. Hit tests and focus reads need a signed-in Mac,
// so this checks that each click and each typed chunk still consults them.
describe("This Mac input delivery gates", () => {
  it("clicks only when the verified target receives mouse input", async () => {
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
      "    guard let routing = clickReachesObservedApplication(at: point) else {\n" +
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
        "          ) == .success else {\n" +
        "      recordClickFailure(.axQueryFailed, at: point)\n" +
        "      return nil\n" +
        "    }\n" +
        "    guard let hitElement else {\n" +
        "      recordClickFailure(.axHitUnavailable, at: point)\n" +
        "      return nil\n" +
        "    }\n" +
        "    guard InputDeliveryPolicy.isWithin(\n" +
        "            hitElement,\n" +
        "            chosen: element,\n" +
        "            limit: Self.maximumHitTargetAncestorDepth,\n" +
        "            parent: { self.axElementAttribute($0, kAXParentAttribute as String) },\n" +
        "            same: { CFEqual($0, $1) }\n" +
        "          ) else {\n" +
        "      recordClickFailure(.axHitMismatch, at: point)\n" +
        "      return nil\n" +
        "    }\n" +
        "    guard let identity = screenshotHitTargetMetadata(hitElement)?.identity else {\n" +
        "      recordClickFailure(.axMetadataUnavailable, at: point)\n" +
        "      return nil\n" +
        "    }\n" +
        "    guard !isSecure(role: identity.role, subrole: identity.subrole) else {\n" +
        "      recordClickFailure(.axSecureTarget, at: point)\n" +
        "      return nil\n" +
        "    }\n" +
        "    return hitElement\n",
    ]) {
      expect(helper.includes(rule), `Missing input-delivery guard: ${rule}`).toBe(true);
    }
  });

  it("uses exact mouse-window ownership and rechecks routing before posting", async () => {
    const helper = await readFile(helperFile, "utf8");
    const postStart = helper.indexOf("  @MainActor\n  private func postValidatedClick(");
    const postEnd = helper.indexOf("  private func typeText(", postStart);
    expect(postStart).toBeGreaterThan(-1);
    expect(postEnd).toBeGreaterThan(postStart);
    const post = helper.slice(postStart, postEnd);
    expect(helper).toContain("try await postValidatedClick(input, taskAuthority: taskAuthority)");
    expect(post).not.toMatch(/\bawait\b/);
    expect(post).toContain("guard AXIsProcessTrusted() else");
    expect(post).toContain("try verifyObservedTarget(");
    expect(post).toContain("if taskAuthority { try requireTaskAuthorityPointerTarget(target) }");
    const recheck =
      "    guard currentAppKitPoint(for: point) == routing.appKitPoint,\n" +
      "          InputDeliveryPolicy.windowID(from: NSWindow.windowNumber(\n" +
      "            at: routing.appKitPoint, belowWindowWithWindowNumber: 0\n" +
      "          )) == routing.windowID\n" +
      "    else {\n" +
      "      recordClickFailure(.mouseRoutingChanged, at: point)\n" +
      "      throw HelperFailure.rejected(Self.clickTargetCovered)\n" +
      "    }\n" +
      "    down.post(tap: .cghidEventTap)\n" +
      "    up.post(tap: .cghidEventTap)\n";
    expect(post.includes(recheck), "Mouse routing must be rechecked immediately before posting").toBe(true);
    expect(post.indexOf(recheck)).toBeGreaterThan(post.indexOf("guard let down = CGEvent("));

    const lookupStart = helper.indexOf("  @MainActor\n  private func clickReachesObservedApplication(");
    const lookupEnd = helper.indexOf("  @MainActor\n  private func currentAppKitPoint(", lookupStart);
    expect(lookupStart).toBeGreaterThan(-1);
    expect(lookupEnd).toBeGreaterThan(lookupStart);
    const lookup = helper.slice(lookupStart, lookupEnd);
    for (const rule of [
      "    guard let expectedPID = snapshotFrontmostPID else {\n" +
        "      recordClickFailure(.windowExpectedApplicationUnavailable, at: point)\n" +
        "      return nil\n" +
        "    }\n",
      "    guard let appKitPoint = currentAppKitPoint(for: point) else {\n" +
        "      recordClickFailure(.screenCoordinatesUnavailable, at: point)\n" +
        "      return nil\n" +
        "    }\n" +
        "    let windowNumber = NSWindow.windowNumber(at: appKitPoint, belowWindowWithWindowNumber: 0)\n" +
        "    guard let windowID = InputDeliveryPolicy.windowID(from: windowNumber) else {\n" +
        "      recordClickFailure(.noWindowAtPoint, at: point)\n" +
        "      return nil\n" +
        "    }\n",
      "    guard let windows = CGWindowListCopyWindowInfo(\n" +
        "            [.optionIncludingWindow], windowID\n" +
        "          ) as? [[String: Any]]\n" +
        "    else {\n" +
        "      recordClickFailure(.windowListUnavailable, at: point)\n" +
        "      return nil\n" +
        "    }\n" +
        "    let inspection = InputDeliveryPolicy.inspectRoutedWindow(\n" +
        "      at: point, windowNumber: windowNumber, windows: windows\n" +
        "    )\n" +
        "    guard inspection.ownerPID == expectedPID else {\n" +
        "      let reason: ClickFailureDiagnostic.Reason\n" +
        "      switch inspection.lookup {\n" +
        "      case .ownerFound: reason = .coveringWindow\n" +
        "      case .identityUnavailable: reason = .windowIdentityUnavailable\n" +
        "      case .boundsUnavailable: reason = .windowBoundsUnavailable\n" +
        "      case .ownerUnavailable: reason = .windowOwnerUnavailable\n" +
        "      case .noWindow: reason = .noWindowAtPoint\n" +
        "      }\n" +
        "      recordClickFailure(reason, at: point, window: inspection)\n" +
        "      return nil\n" +
        "    }\n" +
        "    return (windowID, appKitPoint)\n",
    ]) {
      expect(lookup.includes(rule), `Missing mouse-window ownership guard: ${rule}`).toBe(true);
    }
    expect(lookup).not.toContain(".optionOnScreenOnly");
    expect(helper).not.toContain("InputDeliveryPolicy.inspectWindow(");
    const conversion = helper.slice(lookupEnd, helper.indexOf("  private func recordClickFailure(", lookupEnd));
    expect(conversion).toContain("guard activeDisplayBounds() == snapshotDisplayBounds,");
    expect(conversion).toContain("let primaryScreen = NSScreen.screens.first,");
    expect(conversion).toContain("primaryDisplayID == CGMainDisplayID()");
    expect(conversion).toContain("return InputDeliveryPolicy.appKitPoint(");
    expect(conversion).toContain("primaryAppKitBounds: primaryScreen.frame,");
    expect(conversion).toContain("primaryCGBounds: CGDisplayBounds(primaryDisplayID),");
    expect(conversion).toContain("activeDisplayBounds: snapshotDisplayBounds");
    expect(conversion).not.toContain("NSScreen.main");
  });

  it("logs refusal diagnostics after validation without changing the IPC failure", async () => {
    const helper = await readFile(helperFile, "utf8");
    const executeStart = helper.indexOf("  func execute(_ envelope: [String: Any])");
    const executeEnd = helper.indexOf("  private func validate(", executeStart);
    expect(executeStart).toBeGreaterThan(-1);
    expect(executeEnd).toBeGreaterThan(executeStart);
    const execute = helper.slice(executeStart, executeEnd);
    const validation = execute.indexOf("validated = try validate(envelope, id: id)");
    const cache = execute.indexOf("if let prior = cachedOutput(id: id) { return prior }");
    const reset = execute.indexOf("    clickFailureDiagnostic = nil\n    defer { clickFailureDiagnostic = nil }\n");
    expect(validation).toBeGreaterThan(-1);
    expect(cache).toBeGreaterThan(validation);
    expect(reset).toBeGreaterThan(cache);
    expect(execute).toContain(
      "    } catch HelperFailure.rejected(let code) {\n" +
        "      if let encoded = clickFailureDiagnostic?.encoded(\n" +
        "        commandID: id, action: validated.action, errorCode: code\n" +
        "      ) {\n" +
        "        ClickFailureLog.write(encoded)\n" +
        "      }\n" +
        "      output = response(id: id, outcome: \"failed\", errorCode: code)\n",
    );
    expect(helper.match(/ClickFailureLog\.write\(/g)).toHaveLength(1);
    expect(execute).toContain("output = response(id: id, outcome: \"succeeded\", result: result)");
    expect(execute).toContain("remember(id: id, output: output, expiresAt: validated.expiration)");
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
