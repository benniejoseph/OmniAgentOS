import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const helperFile = "apps/flutter/macos/ComputerUseHelper/HelperMain.swift";

// The policy itself is covered by the Mac helper's RestrictedApplicationPolicy
// suite. Its gates sit on Accessibility calls that need a signed-in Mac, so
// this checks that each way the helper reaches an app still consults it.
describe("This Mac restricted application gates", () => {
  it("checks the app, and a browser's page, before the helper acts", async () => {
    const helper = await readFile(helperFile, "utf8");

    for (const gate of [
      // Switching apps refuses a restricted app and Asael itself.
      "app.activationPolicy == .regular,\n          !refusesTarget(app)\n",
      // Observing refuses a restricted app, then a restricted browser page.
      "if let app, RestrictedApplicationPolicy.refuses(app) {\n" +
        '      throw HelperFailure.rejected("restricted_application_refused")',
      "if let app, let snapshotFocusedWindow,\n" +
        "       showsRestrictedPage(app, window: snapshotFocusedWindow) {\n" +
        "      snapshotTargetApplication = nil\n" +
        '      throw HelperFailure.rejected("restricted_page_refused")',
      // Keys and text reach only an app that may be driven.
      "if let app = NSWorkspace.shared.frontmostApplication, refusesTarget(app) {\n" +
        '      throw HelperFailure.rejected("restricted_application_refused")',
      // Every action on an observation checks its app before restoring focus,
      // then the page its window shows.
      "guard !refusesTarget(targetApplication) else {\n" +
        '      throw HelperFailure.rejected("restricted_application_refused")',
      "showsRestrictedPage(targetApplication, window: window) {\n" +
        '      throw HelperFailure.rejected("restricted_page_refused")',
      // Only a browser's pages are read, and only a refused page stops it.
      "RestrictedApplicationPolicy.readsPages(ofBundleIdentifier: application.bundleIdentifier)\n" +
        "      && browserPageURLs(in: window).contains(where: RestrictedApplicationPolicy.refusesPage)",
      "RestrictedApplicationPolicy.refuses(application)\n" +
        "      || RestrictedApplicationPolicy.isTrustedHost(",
    ]) {
      expect(helper).toContain(gate);
    }
    expect(
      helper.indexOf("guard !refusesTarget(targetApplication) else {"),
    ).toBeLessThan(helper.indexOf("try restoreObservedTarget(targetApplication)"));
  });
});
