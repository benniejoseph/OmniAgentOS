import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { captureTitle, extractCaptureFile } from "@/lib/capture/files";

describe("capture files", () => {
  it("creates a readable title from a filename", () => {
    expect(captureTitle("release_checklist-v2.md")).toBe("release checklist v2");
  });
  it("extracts supported text files with provenance", async () => {
    await expect(extractCaptureFile(new File(["# Notes"], "team-notes.md", { type: "text/markdown" }))).resolves.toMatchObject({
      title: "team notes", content: "# Notes", sourceType: "file",
    });
  });
  it("rejects unsupported and binary text files", async () => {
    await expect(extractCaptureFile(new File(["image"], "photo.bmp"))).rejects.toMatchObject({ status: 415 });
    await expect(extractCaptureFile(new File([new Uint8Array([0, 1])], "data.txt"))).rejects.toMatchObject({ status: 415 });
  });
  it("reports scanned or invalid PDFs as extraction failures", async () => {
    await expect(extractCaptureFile(new File(["not a pdf"], "paper.pdf"))).rejects.toMatchObject({ status: 400 });
  });
  it("extracts text from a real DOCX container", async () => {
    const fixture = await readFile("node_modules/mammoth/test/test-data/tables.docx");
    const result = await extractCaptureFile(new File([fixture], "table-notes.docx"));
    expect(result).toMatchObject({ title: "table notes", sourceType: "file" });
    expect(result.content.length).toBeGreaterThan(10);
  });
  it("requires configured OCR for image captures", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(extractCaptureFile(new File([new Uint8Array([1, 2, 3])], "whiteboard.png"))).rejects.toMatchObject({ status: 503 });
    } finally {
      if (previous) process.env.OPENAI_API_KEY = previous;
    }
  });
  it("extracts reviewable email headers and body", async () => {
    const email = "Subject: Project update\r\nFrom: sender@example.com\r\nTo: me@example.com\r\n\r\nThe launch moved to Friday.";
    const result = await extractCaptureFile(new File([email], "project.eml"));
    expect(result.content).toContain("Subject: Project update");
    expect(result.content).toContain("The launch moved to Friday.");
  });
  it("extracts useful calendar event fields", async () => {
    const calendar = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Weekly review\r\nDTSTART:20260904T100000Z\r\nLOCATION:Studio\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const result = await extractCaptureFile(new File([calendar], "review.ics"));
    expect(result.content).toContain("SUMMARY: Weekly review");
    expect(result.content).toContain("DTSTART: 20260904T100000Z");
  });
});
