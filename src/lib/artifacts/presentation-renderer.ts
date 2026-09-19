import { createHash } from "node:crypto";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import {
  parsePresentationBlueprint,
  presentationSpecDigest,
  type PresentationBlueprint,
  type PresentationSlide,
  type PresentationSlideKind,
  type PresentationTheme,
} from "@/lib/artifacts/presentation-spec";

const PRESENTATION_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");

type Palette = Readonly<{
  background: string;
  surface: string;
  surfaceStrong: string;
  ink: string;
  muted: string;
  accent: string;
  accentTwo: string;
  line: string;
}>;

const palettes: Record<PresentationTheme, Palette> = {
  light: {
    background: "F7F4EA",
    surface: "FFFFFF",
    surfaceStrong: "E8F3EE",
    ink: "12342F",
    muted: "536D68",
    accent: "087F68",
    accentTwo: "B76917",
    line: "C9DED6",
  },
  dark: {
    background: "071C1A",
    surface: "0D2A27",
    surfaceStrong: "143B36",
    ink: "F4FAF7",
    muted: "B5CBC5",
    accent: "6DE3C4",
    accentTwo: "F2C778",
    line: "31534E",
  },
  aurora: {
    background: "091C2D",
    surface: "102B42",
    surfaceStrong: "173B57",
    ink: "F6FAFD",
    muted: "BDD0DC",
    accent: "61DFCF",
    accentTwo: "C59AF7",
    line: "34536A",
  },
};

export type PresentationRenderSummary = Readonly<{
  title: string;
  subtitle?: string;
  theme: PresentationTheme;
  slideCount: number;
  slideKinds: Readonly<Record<PresentationSlideKind, number>>;
  specDigest: string;
}>;

export type PresentationRenderResult = Readonly<{
  bytes: Uint8Array;
  sha256: string;
  byteCount: number;
  mimeType: typeof PRESENTATION_MIME_TYPE;
  extension: "pptx";
  summary: PresentationRenderSummary;
}>;

export async function renderPresentation(input: unknown): Promise<PresentationRenderResult> {
  const blueprint = parsePresentationBlueprint(input);
  const specDigest = presentationSpecDigest(blueprint);
  const palette = palettes[blueprint.theme];
  const pptx = new PptxGenJS();

  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Asael";
  pptx.company = "Asael";
  pptx.subject = blueprint.subtitle || "Created with Asael";
  pptx.title = blueprint.title;
  pptx.revision = "1";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
  };

  for (const [index, specification] of blueprint.slides.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: palette.background };
    addChrome(pptx, slide, palette, specification.kind, index + 1, blueprint.slides.length);
    renderSlide(pptx, slide, specification, palette, index + 1);
    if (specification.speakerNotes) {
      slide.addNotes(specification.speakerNotes);
    }
  }

  const generated = await pptx.write({ outputType: "uint8array", compression: true });
  const bytes = await normalizePptx(asUint8Array(generated));
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  return {
    bytes,
    sha256,
    byteCount: bytes.byteLength,
    mimeType: PRESENTATION_MIME_TYPE,
    extension: "pptx",
    summary: summarize(blueprint, specDigest),
  };
}

function renderSlide(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  specification: PresentationSlide,
  palette: Palette,
  slideNumber: number,
) {
  switch (specification.kind) {
    case "title":
      renderTitleSlide(pptx, slide, specification, palette);
      return;
    case "section":
      renderSectionSlide(pptx, slide, specification, palette, slideNumber);
      return;
    case "content":
      renderContentSlide(pptx, slide, specification, palette);
      return;
    case "two_column":
      renderTwoColumnSlide(pptx, slide, specification, palette);
      return;
    case "quote":
      renderQuoteSlide(pptx, slide, specification, palette);
      return;
    case "metrics":
      renderMetricsSlide(pptx, slide, specification, palette);
      return;
    case "closing":
      renderClosingSlide(pptx, slide, specification, palette);
      return;
  }
}

function addChrome(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  palette: Palette,
  kind: PresentationSlideKind,
  index: number,
  total: number,
) {
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 10.55,
    y: -1.35,
    w: 4.5,
    h: 4.5,
    fill: { color: palette.accent, transparency: 93 },
    line: { color: palette.accent, transparency: 72, width: 1 },
    objectName: "Decorative orbit",
  });
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 11.62,
    y: -0.28,
    w: 2.35,
    h: 2.35,
    fill: { color: palette.accentTwo, transparency: 95 },
    line: { color: palette.accentTwo, transparency: 76, width: 1 },
    objectName: "Decorative inner orbit",
  });
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 12.08,
    y: 0.18,
    w: 0.16,
    h: 0.16,
    fill: { color: palette.accent },
    line: { color: palette.accent, transparency: 100 },
    objectName: "Decorative orbit point",
  });

  slide.addText("ASAEL", {
    x: 0.68,
    y: 0.35,
    w: 1.1,
    h: 0.24,
    margin: 0,
    color: palette.accent,
    bold: true,
    fontFace: "Aptos",
    fontSize: 9,
    charSpacing: 2.2,
    objectName: "Asael brand",
  });
  slide.addText(kind.replace("_", " ").toUpperCase(), {
    x: 1.86,
    y: 0.35,
    w: 2.2,
    h: 0.24,
    margin: 0,
    color: palette.muted,
    fontFace: "Aptos",
    fontSize: 8,
    charSpacing: 1.6,
    objectName: "Slide type",
  });

  slide.addShape(pptx.ShapeType.line, {
    x: 0.68,
    y: 7.05,
    w: 11.98,
    h: 0,
    line: { color: palette.line, transparency: 18, width: 1 },
    objectName: "Footer divider",
  });
  slide.addText(`${String(index).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, {
    x: 11.55,
    y: 7.13,
    w: 1.1,
    h: 0.2,
    margin: 0,
    align: "right",
    color: palette.muted,
    fontFace: "Aptos",
    fontSize: 8,
    objectName: "Slide number",
  });
}

function renderTitleSlide(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  specification: Extract<PresentationSlide, { kind: "title" }>,
  palette: Palette,
) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 8.95,
    y: 1.35,
    w: 3.65,
    h: 4.9,
    rectRadius: 0.08,
    fill: { color: palette.surface },
    line: { color: palette.line, width: 1 },
    objectName: "Title visual panel",
  });
  for (const orbit of [
    { x: 9.53, y: 2.02, w: 2.5, h: 2.5, color: palette.accent },
    { x: 9.91, y: 2.4, w: 1.74, h: 1.74, color: palette.accentTwo },
    { x: 10.32, y: 2.81, w: 0.92, h: 0.92, color: palette.accent },
  ]) {
    slide.addShape(pptx.ShapeType.ellipse, {
      ...orbit,
      fill: { color: orbit.color, transparency: 91 },
      line: { color: orbit.color, transparency: 35, width: 1.2 },
      objectName: "Asael knowledge orbit",
    });
  }
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 10.62,
    y: 3.11,
    w: 0.32,
    h: 0.32,
    fill: { color: palette.accent },
    line: { color: palette.accent },
    objectName: "Asael knowledge core",
  });
  slide.addText("Ideas → evidence → action", {
    x: 9.52,
    y: 5.3,
    w: 2.55,
    h: 0.34,
    margin: 0,
    align: "center",
    color: palette.muted,
    fontFace: "Aptos",
    fontSize: 11,
    objectName: "Title visual caption",
  });

  if (specification.eyebrow) {
    slide.addText(specification.eyebrow.toUpperCase(), {
      x: 0.82,
      y: 1.54,
      w: 6.9,
      h: 0.28,
      margin: 0,
      color: palette.accent,
      fontFace: "Aptos",
      fontSize: 10,
      bold: true,
      charSpacing: 2,
      objectName: "Title eyebrow",
    });
  }
  slide.addText(specification.title, {
    x: 0.82,
    y: specification.eyebrow ? 1.98 : 1.68,
    w: 7.35,
    h: 2.15,
    margin: 0,
    color: palette.ink,
    fontFace: "Aptos Display",
    fontSize: 36,
    bold: true,
    breakLine: false,
    fit: "shrink",
    valign: "middle",
    objectName: "Presentation title",
  });
  if (specification.subtitle) {
    slide.addText(specification.subtitle, {
      x: 0.84,
      y: 4.22,
      w: 6.85,
      h: 1.16,
      margin: 0,
      color: palette.muted,
      fontFace: "Aptos",
      fontSize: 17,
      breakLine: false,
      fit: "shrink",
      valign: "top",
      objectName: "Presentation subtitle",
    });
  }
  slide.addShape(pptx.ShapeType.line, {
    x: 0.84,
    y: 5.84,
    w: 1.35,
    h: 0,
    line: { color: palette.accent, width: 4, beginArrowType: "none", endArrowType: "none" },
    objectName: "Title accent",
  });
}

function renderSectionSlide(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  specification: Extract<PresentationSlide, { kind: "section" }>,
  palette: Palette,
  slideNumber: number,
) {
  slide.addText(String(slideNumber).padStart(2, "0"), {
    x: 0.78,
    y: 1.24,
    w: 2.05,
    h: 1.28,
    margin: 0,
    color: palette.accent,
    fontFace: "Aptos Display",
    fontSize: 54,
    bold: true,
    objectName: "Section number",
  });
  slide.addShape(pptx.ShapeType.line, {
    x: 2.9,
    y: 1.42,
    w: 0,
    h: 4.5,
    line: { color: palette.line, width: 1.5 },
    objectName: "Section divider",
  });
  slide.addText(specification.title, {
    x: 3.45,
    y: 2.0,
    w: 8.05,
    h: 1.65,
    margin: 0,
    color: palette.ink,
    fontFace: "Aptos Display",
    fontSize: 35,
    bold: true,
    fit: "shrink",
    valign: "middle",
    objectName: "Section title",
  });
  if (specification.subtitle) {
    slide.addText(specification.subtitle, {
      x: 3.48,
      y: 3.93,
      w: 7.6,
      h: 1.12,
      margin: 0,
      color: palette.muted,
      fontFace: "Aptos",
      fontSize: 17,
      fit: "shrink",
      objectName: "Section subtitle",
    });
  }
}

function renderContentSlide(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  specification: Extract<PresentationSlide, { kind: "content" }>,
  palette: Palette,
) {
  addStandardTitle(slide, specification.title, specification.kicker, palette);
  const hasBody = Boolean(specification.body);
  const hasBullets = Boolean(specification.bullets?.length);

  if (hasBody) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.75,
      y: 2.02,
      w: hasBullets ? 4.28 : 11.83,
      h: 4.45,
      rectRadius: 0.06,
      fill: { color: palette.surface },
      line: { color: palette.line, width: 1 },
      objectName: "Content body panel",
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.75,
      y: 2.02,
      w: 0.1,
      h: 4.45,
      fill: { color: palette.accent },
      line: { color: palette.accent },
      objectName: "Content body accent",
    });
    slide.addText(specification.body || "", {
      x: 1.14,
      y: 2.43,
      w: hasBullets ? 3.48 : 11.04,
      h: 3.57,
      margin: 0,
      color: palette.ink,
      fontFace: "Aptos",
      fontSize: hasBullets ? 18 : 21,
      breakLine: false,
      fit: "shrink",
      valign: "middle",
      objectName: "Content body",
    });
  }

  if (specification.bullets?.length) {
    const panelX = hasBody ? 5.28 : 0.75;
    const panelWidth = hasBody ? 7.3 : 11.83;
    slide.addShape(pptx.ShapeType.roundRect, {
      x: panelX,
      y: 2.02,
      w: panelWidth,
      h: 4.45,
      rectRadius: 0.06,
      fill: { color: palette.surface },
      line: { color: palette.line, width: 1 },
      objectName: "Content bullets panel",
    });
    const rowHeight = Math.min(0.77, 3.82 / specification.bullets.length);
    specification.bullets.forEach((bullet, index) => {
      const y = 2.36 + index * rowHeight;
      slide.addShape(pptx.ShapeType.ellipse, {
        x: panelX + 0.38,
        y: y + 0.15,
        w: 0.18,
        h: 0.18,
        fill: { color: index % 2 ? palette.accentTwo : palette.accent },
        line: { color: index % 2 ? palette.accentTwo : palette.accent },
        objectName: `Bullet ${index + 1} marker`,
      });
      slide.addText(bullet, {
        x: panelX + 0.75,
        y,
        w: panelWidth - 1.12,
        h: rowHeight - 0.05,
        margin: 0,
        color: palette.ink,
        fontFace: "Aptos",
        fontSize: hasBody ? 15 : 17,
        fit: "shrink",
        valign: "middle",
        objectName: `Bullet ${index + 1}`,
      });
    });
  }
}

function renderTwoColumnSlide(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  specification: Extract<PresentationSlide, { kind: "two_column" }>,
  palette: Palette,
) {
  addStandardTitle(slide, specification.title, specification.subtitle, palette);
  renderColumn(pptx, slide, 0.75, specification.left, palette, palette.accent, "Left");
  renderColumn(pptx, slide, 6.79, specification.right, palette, palette.accentTwo, "Right");
}

function renderColumn(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  x: number,
  column: Extract<PresentationSlide, { kind: "two_column" }>["left"],
  palette: Palette,
  accent: string,
  label: string,
) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y: 2.12,
    w: 5.79,
    h: 4.27,
    rectRadius: 0.06,
    fill: { color: palette.surface },
    line: { color: palette.line, width: 1 },
    objectName: `${label} column panel`,
  });
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y: 2.12,
    w: 5.79,
    h: 0.1,
    fill: { color: accent },
    line: { color: accent },
    objectName: `${label} column accent`,
  });
  slide.addText(column.heading, {
    x: x + 0.42,
    y: 2.5,
    w: 4.95,
    h: 0.52,
    margin: 0,
    color: palette.ink,
    fontFace: "Aptos Display",
    fontSize: 21,
    bold: true,
    fit: "shrink",
    objectName: `${label} column heading`,
  });
  let contentY = 3.27;
  if (column.body) {
    slide.addText(column.body, {
      x: x + 0.42,
      y: contentY,
      w: 4.95,
      h: column.bullets?.length ? 1.05 : 2.55,
      margin: 0,
      color: palette.muted,
      fontFace: "Aptos",
      fontSize: 14,
      fit: "shrink",
      valign: "top",
      objectName: `${label} column body`,
    });
    contentY += column.bullets?.length ? 1.25 : 0;
  }
  if (column.bullets?.length) {
    const rowHeight = Math.min(0.61, (6.0 - contentY) / column.bullets.length);
    column.bullets.forEach((bullet, index) => {
      const y = contentY + index * rowHeight;
      slide.addShape(pptx.ShapeType.ellipse, {
        x: x + 0.43,
        y: y + 0.13,
        w: 0.14,
        h: 0.14,
        fill: { color: accent },
        line: { color: accent },
        objectName: `${label} bullet ${index + 1} marker`,
      });
      slide.addText(bullet, {
        x: x + 0.72,
        y,
        w: 4.6,
        h: rowHeight - 0.02,
        margin: 0,
        color: palette.ink,
        fontFace: "Aptos",
        fontSize: 13,
        fit: "shrink",
        valign: "middle",
        objectName: `${label} bullet ${index + 1}`,
      });
    });
  }
}

function renderQuoteSlide(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  specification: Extract<PresentationSlide, { kind: "quote" }>,
  palette: Palette,
) {
  addStandardTitle(slide, specification.title, undefined, palette);
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 1.22,
    y: 2.0,
    w: 10.88,
    h: 4.28,
    rectRadius: 0.08,
    fill: { color: palette.surface },
    line: { color: palette.line, width: 1 },
    objectName: "Quote panel",
  });
  slide.addText("“", {
    x: 1.66,
    y: 2.23,
    w: 1.05,
    h: 1.12,
    margin: 0,
    color: palette.accent,
    fontFace: "Georgia",
    fontSize: 58,
    bold: true,
    objectName: "Opening quote mark",
  });
  slide.addText(specification.quote, {
    x: 2.55,
    y: 2.53,
    w: 8.42,
    h: 2.08,
    margin: 0,
    color: palette.ink,
    fontFace: "Aptos Display",
    fontSize: 25,
    italic: true,
    fit: "shrink",
    valign: "middle",
    objectName: "Quotation",
  });
  slide.addShape(pptx.ShapeType.line, {
    x: 2.55,
    y: 5.03,
    w: 0.7,
    h: 0,
    line: { color: palette.accentTwo, width: 3 },
    objectName: "Quote attribution accent",
  });
  slide.addText(specification.attribution, {
    x: 3.48,
    y: 4.85,
    w: 3.65,
    h: 0.34,
    margin: 0,
    color: palette.ink,
    fontFace: "Aptos",
    fontSize: 13,
    bold: true,
    objectName: "Quote attribution",
  });
  if (specification.role) {
    slide.addText(specification.role, {
      x: 3.48,
      y: 5.22,
      w: 4.65,
      h: 0.3,
      margin: 0,
      color: palette.muted,
      fontFace: "Aptos",
      fontSize: 11,
      objectName: "Quote role",
    });
  }
}

function renderMetricsSlide(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  specification: Extract<PresentationSlide, { kind: "metrics" }>,
  palette: Palette,
) {
  addStandardTitle(slide, specification.title, specification.subtitle, palette);
  const gap = 0.22;
  const totalWidth = 11.83;
  const cardWidth = (totalWidth - gap * (specification.metrics.length - 1)) / specification.metrics.length;

  specification.metrics.forEach((metric, index) => {
    const x = 0.75 + index * (cardWidth + gap);
    const accent = index % 2 ? palette.accentTwo : palette.accent;
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y: 2.25,
      w: cardWidth,
      h: 3.95,
      rectRadius: 0.06,
      fill: { color: palette.surface },
      line: { color: palette.line, width: 1 },
      objectName: `Metric ${index + 1} panel`,
    });
    slide.addShape(pptx.ShapeType.ellipse, {
      x: x + 0.38,
      y: 2.64,
      w: 0.32,
      h: 0.32,
      fill: { color: accent },
      line: { color: accent },
      objectName: `Metric ${index + 1} accent`,
    });
    slide.addText(metric.value, {
      x: x + 0.38,
      y: 3.12,
      w: cardWidth - 0.76,
      h: 0.88,
      margin: 0,
      color: palette.ink,
      fontFace: "Aptos Display",
      fontSize: specification.metrics.length === 4 ? 27 : 31,
      bold: true,
      fit: "shrink",
      objectName: `Metric ${index + 1} value`,
    });
    slide.addText(metric.label, {
      x: x + 0.38,
      y: 4.17,
      w: cardWidth - 0.76,
      h: 0.58,
      margin: 0,
      color: accent,
      fontFace: "Aptos",
      fontSize: 13,
      bold: true,
      fit: "shrink",
      objectName: `Metric ${index + 1} label`,
    });
    if (metric.detail) {
      slide.addText(metric.detail, {
        x: x + 0.38,
        y: 4.92,
        w: cardWidth - 0.76,
        h: 0.83,
        margin: 0,
        color: palette.muted,
        fontFace: "Aptos",
        fontSize: 10.5,
        fit: "shrink",
        valign: "top",
        objectName: `Metric ${index + 1} detail`,
      });
    }
  });
}

function renderClosingSlide(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  specification: Extract<PresentationSlide, { kind: "closing" }>,
  palette: Palette,
) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.82,
    y: 1.35,
    w: 11.68,
    h: 4.95,
    rectRadius: 0.09,
    fill: { color: palette.surface },
    line: { color: palette.line, width: 1 },
    objectName: "Closing panel",
  });
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.82,
    y: 1.35,
    w: 0.12,
    h: 4.95,
    fill: { color: palette.accent },
    line: { color: palette.accent },
    objectName: "Closing accent",
  });
  slide.addText(specification.title, {
    x: 1.42,
    y: 1.9,
    w: 8.5,
    h: 1.22,
    margin: 0,
    color: palette.ink,
    fontFace: "Aptos Display",
    fontSize: 34,
    bold: true,
    fit: "shrink",
    objectName: "Closing title",
  });
  if (specification.subtitle) {
    slide.addText(specification.subtitle, {
      x: 1.44,
      y: 3.27,
      w: 8.2,
      h: 1.05,
      margin: 0,
      color: palette.muted,
      fontFace: "Aptos",
      fontSize: 17,
      fit: "shrink",
      objectName: "Closing subtitle",
    });
  }
  if (specification.callToAction) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 1.42,
      y: 4.72,
      w: Math.min(5.8, Math.max(2.55, specification.callToAction.length * 0.072 + 1.1)),
      h: 0.72,
      rectRadius: 0.1,
      fill: { color: palette.accent },
      line: { color: palette.accent },
      objectName: "Closing call-to-action panel",
    });
    slide.addText(specification.callToAction, {
      x: 1.7,
      y: 4.91,
      w: Math.min(5.22, Math.max(1.97, specification.callToAction.length * 0.072 + 0.52)),
      h: 0.28,
      margin: 0,
      align: "center",
      color: palette.background,
      fontFace: "Aptos",
      fontSize: 12,
      bold: true,
      fit: "shrink",
      objectName: "Closing call to action",
    });
  }
  if (specification.contact) {
    slide.addText(specification.contact, {
      x: 7.02,
      y: 5.0,
      w: 4.7,
      h: 0.3,
      margin: 0,
      align: "right",
      color: palette.muted,
      fontFace: "Aptos",
      fontSize: 10,
      fit: "shrink",
      objectName: "Closing contact",
    });
  }
}

function addStandardTitle(
  slide: PptxGenJS.Slide,
  title: string,
  subtitle: string | undefined,
  palette: Palette,
) {
  slide.addText(title, {
    x: 0.75,
    y: 0.83,
    w: 10.6,
    h: 0.68,
    margin: 0,
    color: palette.ink,
    fontFace: "Aptos Display",
    fontSize: 27,
    bold: true,
    fit: "shrink",
    objectName: "Slide title",
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.77,
      y: 1.52,
      w: 10.55,
      h: 0.42,
      margin: 0,
      color: palette.muted,
      fontFace: "Aptos",
      fontSize: 11,
      fit: "shrink",
      objectName: "Slide subtitle",
    });
  }
}

function summarize(blueprint: PresentationBlueprint, specDigest: string): PresentationRenderSummary {
  const slideKinds: Record<PresentationSlideKind, number> = {
    title: 0,
    section: 0,
    content: 0,
    two_column: 0,
    quote: 0,
    metrics: 0,
    closing: 0,
  };
  for (const slide of blueprint.slides) {
    slideKinds[slide.kind] += 1;
  }
  return {
    title: blueprint.title,
    ...(blueprint.subtitle ? { subtitle: blueprint.subtitle } : {}),
    theme: blueprint.theme,
    slideCount: blueprint.slides.length,
    slideKinds,
    specDigest,
  };
}

function asUint8Array(value: string | ArrayBuffer | Blob | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("PptxGenJS returned an unsupported binary output type.");
}

async function normalizePptx(bytes: Uint8Array): Promise<Uint8Array> {
  const source = await JSZip.loadAsync(bytes);
  const normalized = new JSZip();
  const names = Object.keys(source.files)
    .filter((name) => !source.files[name]?.dir)
    .sort();

  for (const name of names) {
    const file = source.file(name);
    if (!file) continue;
    let contents = await file.async("uint8array");
    if (name === "[Content_Types].xml") {
      const xml = new TextDecoder().decode(contents)
        // PptxGenJS 4.0.1 declares slideMaster2..N for N slides while only
        // writing slideMaster1. Remove only those orphaned declarations so
        // strict OOXML consumers do not treat an otherwise valid deck as a
        // damaged package.
        .replace(
          /<Override PartName="\/(ppt\/slideMasters\/slideMaster\d+\.xml)" ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.slideMaster\+xml"\/>/gu,
          (declaration, partName: string) => source.file(partName) ? declaration : "",
        );
      contents = new TextEncoder().encode(xml);
    } else if (name === "docProps/core.xml") {
      const xml = new TextDecoder().decode(contents)
        .replace(
          /<dcterms:(?:created|modified) xsi:type="dcterms:W3CDTF">[^<]+<\/dcterms:(created|modified)>/gu,
          (_match, field: string) => `<dcterms:${field} xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:${field}>`,
        );
      contents = new TextEncoder().encode(xml);
    }
    normalized.file(name, contents, {
      binary: true,
      createFolders: false,
      date: FIXED_ZIP_DATE,
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
  }

  return normalized.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
  });
}
