import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PrivateMediaPreview,
  normalizePrivateMediaAssetId,
  privateCaptureAssetContentUrl,
  privateMediaFailureState,
  privateMediaRetryDelay,
} from "@/components/media/private-media-preview";

describe("private media preview", () => {
  it("constructs only the owner-scoped Capture content route", () => {
    expect(privateCaptureAssetContentUrl("capture_asset_abc-123"))
      .toBe("/api/capture/assets/capture_asset_abc-123?content=1");
    expect(privateCaptureAssetContentUrl("capture_asset_abc-123", {
      attempt: 4,
      download: true,
    })).toBe(
      "/api/capture/assets/capture_asset_abc-123?content=1&download=1&previewAttempt=4",
    );
  });

  it.each([
    "https://attacker.example/image.png",
    "/api/capture/assets/safe?content=1",
    "safe?content=1",
    "safe/other",
    "",
    "a".repeat(201),
  ])("rejects an arbitrary or malformed reference: %s", (value) => {
    expect(normalizePrivateMediaAssetId(value)).toBeUndefined();
    expect(privateCaptureAssetContentUrl(value)).toBeUndefined();
  });

  it("renders a clear preparing state without accepting a provider URL", () => {
    const html = renderToStaticMarkup(createElement(PrivateMediaPreview, {
      assetId: "capture_asset_abc123",
      kind: "image",
      alt: "Generated private image",
    }));

    expect(html).toContain("Preparing your private image");
    expect(html).toContain("after encrypted storage verifies the file");
    expect(html).toContain("/api/capture/assets/capture_asset_abc123?content=1");
    expect(html).not.toContain("attacker.example");
  });

  it("does not render media when the asset id is unsafe", () => {
    const html = renderToStaticMarkup(createElement(PrivateMediaPreview, {
      assetId: "https://attacker.example/image.png",
      kind: "image",
      alt: "Unsafe image",
    }));

    expect(html).toContain("Preview unavailable");
    expect(html).toContain("media reference is invalid");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
  });

  it("prepares private video metadata without exposing hidden controls to the keyboard", () => {
    const html = renderToStaticMarkup(createElement(PrivateMediaPreview, {
      assetId: "capture_asset_video123",
      kind: "video",
      alt: "Generated private video",
    }));

    expect(html).toContain("Preparing your private video");
    expect(html).toContain("<video");
    expect(html).toContain("preload=\"metadata\"");
    expect(html).toContain("tabindex=\"-1\"");
    expect(html).toContain("/api/capture/assets/capture_asset_video123?content=1");
  });

  it("retries a pending object with bounded backoff and stops on decode failure", () => {
    expect(privateMediaRetryDelay(0)).toBe(2_000);
    expect(privateMediaRetryDelay(20)).toBe(15_000);
    expect(privateMediaRetryDelay(100)).toBe(15_000);
    expect(privateMediaFailureState({
      attempt: 2,
      maxAutomaticRetries: 18,
      wasReady: false,
    })).toEqual({ readiness: "preparing", retry: true });
    expect(privateMediaFailureState({
      attempt: 18,
      maxAutomaticRetries: 18,
      wasReady: false,
    })).toEqual({ readiness: "failed", retry: false });
    expect(privateMediaFailureState({
      attempt: 1,
      maxAutomaticRetries: 18,
      wasReady: true,
    })).toEqual({ readiness: "failed", retry: false });
  });
});
