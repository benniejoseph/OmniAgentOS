import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { renderPresentation } from "@/lib/artifacts/presentation-renderer";

const completeBlueprint = {
  title: "AIForce for Service Cloud",
  subtitle: "A practical client pitch generated inside Asael",
  theme: "aurora" as const,
  slides: [
    {
      kind: "title" as const,
      eyebrow: "CLIENT PITCH",
      title: "Turn Service Cloud into an AI-powered service operation",
      subtitle: "A governed path from repetitive work to faster customer outcomes",
      speakerNotes: "Speaker note: lead with the client's service outcomes.",
    },
    {
      kind: "section" as const,
      title: "The opportunity",
      subtitle: "Improve speed without weakening control.",
    },
    {
      kind: "content" as const,
      title: "Why change now",
      kicker: "SERVICE PRESSURE",
      body: "Teams are carrying more channels, more context, and higher expectations with the same operating model.",
      bullets: [
        "Summarize cases and customer history before the first response",
        "Draft grounded replies and next-best actions for agent review",
        "Turn approved resolutions into reusable knowledge",
      ],
    },
    {
      kind: "two_column" as const,
      title: "From fragmented work to one governed flow",
      subtitle: "Keep people in control while agents handle the repetitive steps.",
      left: {
        heading: "Today",
        bullets: ["Manual context gathering", "Inconsistent handoffs", "Knowledge trapped in cases"],
      },
      right: {
        heading: "With AIForce",
        body: "A connected service copilot works across the lifecycle.",
        bullets: ["Grounded recommendations", "Approval-aware actions", "Observable outcomes"],
      },
    },
    {
      kind: "quote" as const,
      title: "The experience we are designing",
      quote: "Agents should spend their judgment on customers, not on reconstructing context.",
      attribution: "Service transformation principle",
      role: "AIForce delivery team",
    },
    {
      kind: "metrics" as const,
      title: "Pilot measures that matter",
      subtitle: "Baseline first, then verify every claimed improvement.",
      metrics: [
        { value: "-20%", label: "Handle time", detail: "Target range after a measured pilot" },
        { value: "+15%", label: "First-contact resolution", detail: "Supported by grounded responses" },
        { value: "100%", label: "Action traceability", detail: "Governed execution evidence" },
      ],
    },
    {
      kind: "closing" as const,
      title: "Start with one service journey",
      subtitle: "Select a high-volume use case, establish the baseline, and prove value in a bounded pilot.",
      callToAction: "Design the pilot",
      contact: "Prepared in Asael",
      speakerNotes: "Close by agreeing the pilot owner and baseline window.",
    },
  ],
};

describe("renderPresentation", () => {
  it("renders an editable, normalized 16:9 PPTX with notes and metadata", async () => {
    const result = await renderPresentation(completeBlueprint);

    expect(result.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(result.extension).toBe("pptx");
    expect(result.byteCount).toBe(result.bytes.byteLength);
    expect(result.byteCount).toBeGreaterThan(20_000);
    expect(result.sha256).toBe(createHash("sha256").update(result.bytes).digest("hex"));
    expect(result.summary).toMatchObject({
      title: "AIForce for Service Cloud",
      theme: "aurora",
      slideCount: 7,
      slideKinds: {
        title: 1,
        section: 1,
        content: 1,
        two_column: 1,
        quote: 1,
        metrics: 1,
        closing: 1,
      },
    });
    expect(result.summary.specDigest).toMatch(/^[a-f0-9]{64}$/u);

    const zip = await JSZip.loadAsync(result.bytes);
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
    expect(slideNames).toHaveLength(7);

    const slideXml = (await Promise.all(slideNames.map(async (name) => (
      zip.file(name)?.async("string") || ""
    )))).join("\n");
    expect(slideXml).toContain("Turn Service Cloud into an AI-powered service operation");
    expect(slideXml).toContain("Manual context gathering");
    expect(slideXml).toContain("Pilot measures that matter");
    expect(slideXml).toContain("<a:t>");
    expect(Object.keys(zip.files).some((name) => /^ppt\/media\/.+$/u.test(name))).toBe(false);

    const noteNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(name));
    const notesXml = (await Promise.all(noteNames.map(async (name) => (
      zip.file(name)?.async("string") || ""
    )))).join("\n");
    expect(notesXml).toContain("Speaker note: lead with the client&apos;s service outcomes.");
    expect(notesXml).toContain("Close by agreeing the pilot owner and baseline window.");

    const coreXml = await zip.file("docProps/core.xml")?.async("string");
    expect(coreXml).toContain("<dc:title>AIForce for Service Cloud</dc:title>");
    expect(coreXml).toContain("<dc:creator>Asael</dc:creator>");
    expect(coreXml).toContain("2000-01-01T00:00:00Z");

    const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
    expect(presentationXml).toContain('<p:sldSz cx="12192000" cy="6858000"');

    const contentTypesXml = await zip.file("[Content_Types].xml")?.async("string");
    expect(contentTypesXml).toContain('PartName="/ppt/slideMasters/slideMaster1.xml"');
    expect(contentTypesXml).not.toMatch(/PartName="\/ppt\/slideMasters\/slideMaster(?:[2-9]|\d{2,})\.xml"/u);
  });

  it("produces the same normalized package for the same blueprint", async () => {
    const first = await renderPresentation(completeBlueprint);
    const second = await renderPresentation(completeBlueprint);

    expect(second.summary.specDigest).toBe(first.summary.specDigest);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toEqual(first.bytes);
  });
});
