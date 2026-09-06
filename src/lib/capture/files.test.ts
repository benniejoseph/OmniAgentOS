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
      extraction: {
        sourceKind: "document",
        state: "completed",
        units: [{ locator: { kind: "text_span" } }],
      },
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
    expect(result.extraction.units.map((unit) => unit.locator.kind)).toEqual([
      "email_section",
      "email_section",
    ]);
  });
  it("extracts useful calendar event fields", async () => {
    const calendar = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Weekly review\r\nDTSTART:20260904T100000Z\r\nLOCATION:Studio\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const result = await extractCaptureFile(new File([calendar], "review.ics"));
    expect(result.content).toContain("SUMMARY: Weekly review");
    expect(result.content).toContain("DTSTART: 20260904T100000Z");
  });

  it("normalizes delimited rows into sheet-range evidence", async () => {
    const result = await extractCaptureFile(new File([
      "name,status\nAlpha,ready\nBeta,pending",
    ], "projects.csv", { type: "text/csv" }));

    expect(result.extraction).toMatchObject({
      sourceKind: "spreadsheet",
      format: "csv",
      state: "completed",
      units: [{
        locator: {
          kind: "sheet_range",
          startRow: 1,
          endRowExclusive: 4,
          startColumn: 1,
          endColumnExclusive: 3,
        },
      }],
    });
  });

  it("preserves spreadsheet sheets and presentation slides as evidence units", async () => {
    const JSZip = (await import("jszip")).default;
    const workbook = new JSZip();
    workbook.file("xl/sharedStrings.xml", "<sst><si><t>Alpha</t></si><si><t>Ready</t></si></sst>");
    workbook.file("xl/worksheets/sheet1.xml", "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row></sheetData></worksheet>");
    const workbookBytes = await workbook.generateAsync({ type: "uint8array" });
    const spreadsheet = await extractCaptureFile(new File([Buffer.from(workbookBytes)], "status.xlsx"));

    const presentationArchive = new JSZip();
    presentationArchive.file("ppt/slides/slide1.xml", "<p:sld><a:t>Quarterly review</a:t></p:sld>");
    presentationArchive.file("ppt/slides/slide2.xml", "<p:sld><a:t>Next actions</a:t></p:sld>");
    const presentationBytes = await presentationArchive.generateAsync({ type: "uint8array" });
    const presentation = await extractCaptureFile(new File([Buffer.from(presentationBytes)], "review.pptx"));

    expect(spreadsheet.extraction.units[0].locator.kind).toBe("sheet_range");
    expect(spreadsheet.content).toContain("Alpha\tReady");
    expect(presentation.extraction.units.map((unit) => unit.locator.kind)).toEqual([
      "slide",
      "slide",
    ]);
  });
});
