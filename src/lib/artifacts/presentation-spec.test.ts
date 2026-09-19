import { describe, expect, it } from "vitest";
import {
  parsePresentationBlueprint,
  presentationBlueprintSchema,
  presentationSpecDigest,
} from "@/lib/artifacts/presentation-spec";

const baseBlueprint = {
  title: "A governed artifact system",
  subtitle: "Editable presentations created by Asael",
  theme: "light" as const,
  slides: [
    {
      kind: "title" as const,
      title: "A governed artifact system",
      subtitle: "From request to editable deck",
    },
    {
      kind: "closing" as const,
      title: "Ready to create",
      callToAction: "Start in Command",
    },
  ],
};

describe("presentationBlueprintSchema", () => {
  it("parses the supported bounded blueprint", () => {
    const parsed = parsePresentationBlueprint(baseBlueprint);

    expect(parsed.title).toBe("A governed artifact system");
    expect(parsed.slides).toHaveLength(2);
    expect(parsed.slides.map((slide) => slide.kind)).toEqual(["title", "closing"]);
  });

  it("rejects unknown fields and unsupported slide kinds", () => {
    expect(() => parsePresentationBlueprint({
      ...baseBlueprint,
      execute: "arbitrary-code",
    })).toThrow();

    expect(() => parsePresentationBlueprint({
      ...baseBlueprint,
      slides: [
        baseBlueprint.slides[0],
        { kind: "html", title: "Unsupported", html: "<script />" },
      ],
    })).toThrow();

    expect(() => parsePresentationBlueprint({
      ...baseBlueprint,
      slides: [
        { ...baseBlueprint.slides[0], remoteImageUrl: "https://example.test/image.png" },
        baseBlueprint.slides[1],
      ],
    })).toThrow();
  });

  it("enforces the slide-count, visible-content, and text-shape limits", () => {
    expect(presentationBlueprintSchema.safeParse({
      ...baseBlueprint,
      slides: [baseBlueprint.slides[0]],
    }).success).toBe(false);

    expect(presentationBlueprintSchema.safeParse({
      ...baseBlueprint,
      slides: Array.from({ length: 25 }, (_, index) => ({
        kind: "section",
        title: `Section ${index + 1}`,
      })),
    }).success).toBe(false);

    expect(presentationBlueprintSchema.safeParse({
      ...baseBlueprint,
      slides: [
        baseBlueprint.slides[0],
        {
          kind: "content",
          title: "Too dense",
          body: "A".repeat(300),
          bullets: Array.from({ length: 4 }, () => "B".repeat(110)),
        },
      ],
    }).success).toBe(false);

    expect(presentationBlueprintSchema.safeParse({
      ...baseBlueprint,
      slides: [
        baseBlueprint.slides[0],
        { kind: "content", title: "Empty" },
      ],
    }).success).toBe(false);

    expect(presentationBlueprintSchema.safeParse({
      ...baseBlueprint,
      title: "Invalid\nheading",
    }).success).toBe(false);
  });

  it("produces a stable canonical digest", () => {
    expect(presentationSpecDigest(baseBlueprint)).toBe(
      "550bd7c1ea8a14e85cb309b422f469a5f0cad10d62b6fbe14a3a14668e733a11",
    );

    const reordered = {
      slides: baseBlueprint.slides.map((slide) => ({ ...slide })),
      theme: baseBlueprint.theme,
      subtitle: baseBlueprint.subtitle,
      title: baseBlueprint.title,
    };
    expect(presentationSpecDigest(reordered)).toBe(presentationSpecDigest(baseBlueprint));
  });
});
