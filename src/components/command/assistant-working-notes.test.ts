import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantWorkingNotes } from "./assistant-working-notes";

describe("working notes disclosure", () => {
  const events = [
    { type: "status", label: "Reading the project", detail: "Checking the README." },
    { type: "model", reasoning: "DO_NOT_DISPLAY", output: "RAW_OUTPUT" },
  ];
  const render = (terminal: boolean, status: string) => renderToStaticMarkup(createElement(AssistantWorkingNotes, {
    terminal, status, events, summary: "Preparing the response", onOpen: () => undefined,
  }));

  it("opens actual progress while working, with access to full activity", () => {
    const html = render(false, "Working on your request");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Checking the README.");
    expect(html).toContain("All activity and results");
    expect(html).not.toMatch(/DO_NOT_DISPLAY|RAW_OUTPUT/);
  });
  it("collapses completed work and keeps its real status visible", () => {
    const html = render(true, "Response ready");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Response ready");
    expect(html).not.toContain("Checking the README.");
  });
  it("keeps an approval wait open and does not call it complete", () => {
    const html = render(false, "Approval required");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Approval required");
    expect(html).not.toContain("Response ready");
  });
});
