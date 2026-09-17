import { describe, expect, it } from "vitest";
import {
  renderModelComputerObservation,
  sanitizeModelComputerObservation,
} from "@/lib/models/computer-observation";

const webp = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]).toString("base64");

describe("local Computer Use model observation", () => {
  it("bounds safe application state and keeps an authenticated image disclosure", () => {
    const observation = sanitizeModelComputerObservation({
      schemaVersion: 1,
      source: "local_macos",
      trust: "untrusted_data",
      executionId: "execution-1",
      operation: "local.macos.click",
      snapshotRevision: "a".repeat(64),
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
    const rendered = renderModelComputerObservation(observation!);
    expect(rendered).toContain("Untrusted local Mac observation");
    expect(rendered).toContain("&lt;Continue&gt;");
    expect(rendered).not.toContain("token=secret");
  });

  it("removes image bytes when the target has no vision disclosure", () => {
    const observation = sanitizeModelComputerObservation({
      schemaVersion: 1,
      source: "local_macos",
      trust: "untrusted_data",
      executionId: "execution-2",
      operation: "local.macos.observe",
      snapshotRevision: "b".repeat(64),
      accessibilitySnapshot: "- heading \"Done\"",
      screenshot: { mimeType: "image/webp", dataBase64: webp },
    }, { includeImage: false });

    expect(observation?.accessibilitySnapshot).toContain("Done");
    expect(observation).not.toHaveProperty("screenshot");
  });

  it("exposes only bounded screenshot-pixel dimensions from local provenance", () => {
    const observation = sanitizeModelComputerObservation({
      schemaVersion: 1,
      source: "local_macos",
      trust: "untrusted_data",
      executionId: "execution-local-coordinate",
      operation: "observe",
      snapshotRevision: "a".repeat(64),
      screenshot: {
        mimeType: "image/webp",
        dataBase64: webp,
        widthPixels: 1_440,
        heightPixels: 900,
        coordinateSpace: "screenshot_pixel",
        coordinateContract: {
          display: { id: 42, logicalBounds: { x: -1_512, y: 0 } },
          target: { pid: 820 },
        },
      },
    }, { includeImage: true });

    expect(observation?.screenshot).toEqual({
      mimeType: "image/webp",
      dataBase64: webp,
      widthPixels: 1_440,
      heightPixels: 900,
      coordinateSpace: "screenshot_pixel",
    });
    expect(observation).not.toHaveProperty(
      "screenshot.coordinateContract",
    );
    expect(renderModelComputerObservation(observation!)).toContain(
      "1440 × 900 pixels; screenshot_pixel origin is upper-left",
    );
  });

  it("withholds incomplete coordinate metadata while retaining a valid image", () => {
    const observation = sanitizeModelComputerObservation({
      schemaVersion: 1,
      source: "local_macos",
      trust: "untrusted_data",
      executionId: "execution-local-incomplete-coordinate",
      operation: "observe",
      snapshotRevision: "a".repeat(64),
      screenshot: {
        mimeType: "image/webp",
        dataBase64: webp,
        widthPixels: 1_440,
        coordinateSpace: "screenshot_pixel",
      },
    }, { includeImage: true });

    expect(observation?.screenshot).toEqual({
      mimeType: "image/webp",
      dataBase64: webp,
    });
    expect(renderModelComputerObservation(observation!)).toContain(
      "use an Accessibility element, not x/y",
    );
  });

  it("rejects retired browser provenance, unlabeled input, and invalid images", () => {
    expect(sanitizeModelComputerObservation({
      schemaVersion: 1,
      source: "browser",
      trust: "untrusted_data",
      executionId: "execution-retired",
      operation: "browser_click",
      snapshotRevision: "c".repeat(64),
      accessibilitySnapshot: "- heading Retired",
    }, { includeImage: true })).toBeUndefined();
    expect(sanitizeModelComputerObservation({
      executionId: "execution-3",
      screenshot: { mimeType: "image/webp", dataBase64: webp },
    }, { includeImage: true })).toBeUndefined();
    expect(sanitizeModelComputerObservation({
      schemaVersion: 1,
      source: "local_macos",
      trust: "untrusted_data",
      executionId: "execution-3",
      operation: "local.macos.click",
      snapshotRevision: "d".repeat(64),
      screenshot: { mimeType: "image/webp", dataBase64: "not-an-image" },
    }, { includeImage: true })).toBeUndefined();
  });
});
