import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function luminance(hex: string) {
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = rgb.map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

function ratio(a: string, b: string) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + .05) / (low + .05);
}

describe("shared UI palette readability", () => {
  it.each([":root", ':root[data-theme="dark"]'])("keeps %s text and essential boundaries legible", (selector) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf("}", start));
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((match) => [match[1], match[2]]));
    for (const surface of ["background", "surface", "surface-raised", "surface-overlay", "surface-navigation"]) {
      for (const text of ["foreground", "muted", "accent"]) {
        expect(ratio(tokens[text], tokens[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(ratio(tokens.focus, tokens[surface]), `focus on ${surface}`).toBeGreaterThanOrEqual(3);
    }
    for (const fill of ["primary", "primary-hover", "primary-pressed"]) {
      expect(ratio(tokens["primary-ink"], tokens[fill]), `primary ink on ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const kind of ["success", "warning", "danger", "info", "accent"]) {
      expect(ratio(tokens[kind], tokens[`${kind}-surface`]), `${kind} status text`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
