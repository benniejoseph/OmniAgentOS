import { describe, expect, it } from "vitest";
import {
  renderModelBrowserObservation,
  sanitizeModelBrowserObservation,
} from "@/lib/models/browser-observation";

const webp = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]).toString("base64");

describe("browser model observation", () => {
  it("bounds safe page state and keeps an authenticated image disclosure", () => {
    const observation = sanitizeModelBrowserObservation({
      schemaVersion: 1,
      source: "browser",
      trust: "untrusted_data",
      executionId: "execution-1",
      operation: "browser_click",
      pageState: {
        url: "https://example.test/account?token=secret#private",
        origin: "https://example.test/ignored",
        title: "Account",
      },
      accessibilitySnapshot: "- button <Continue> [ref=e7]",
      screenshot: { mimeType: "image/webp", dataBase64: webp },
    }, { includeImage: true });

    expect(observation).toMatchObject({
      executionId: "execution-1",
      pageState: {
        url: "https://example.test/account",
        origin: "https://example.test",
      },
      screenshot: { mimeType: "image/webp" },
    });
    const rendered = renderModelBrowserObservation(observation!);
    expect(rendered).toContain("Untrusted browser observation");
    expect(rendered).toContain("&lt;Continue&gt;");
    expect(rendered).not.toContain("token=secret");
  });

  it("removes image bytes when the target has no vision disclosure", () => {
    const observation = sanitizeModelBrowserObservation({
      schemaVersion: 1,
      source: "browser",
      trust: "untrusted_data",
      executionId: "execution-2",
      operation: "browser_snapshot",
      accessibilitySnapshot: "- heading \"Done\"",
      screenshot: { mimeType: "image/webp", dataBase64: webp },
    }, { includeImage: false });

    expect(observation?.accessibilitySnapshot).toContain("Done");
    expect(observation).not.toHaveProperty("screenshot");
  });

  it("rejects unlabeled or invalid image observations", () => {
    expect(sanitizeModelBrowserObservation({
      executionId: "execution-3",
      screenshot: { mimeType: "image/webp", dataBase64: webp },
    }, { includeImage: true })).toBeUndefined();
    expect(sanitizeModelBrowserObservation({
      schemaVersion: 1,
      source: "browser",
      trust: "untrusted_data",
      executionId: "execution-3",
      operation: "browser_click",
      screenshot: { mimeType: "image/webp", dataBase64: "not-an-image" },
    }, { includeImage: true })).toBeUndefined();
  });
});
