import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import CommandError from "@/app/app/command/error";

describe("Command error recovery", () => {
  it("keeps recovery inside the app with a retry and safe exit", () => {
    const html = renderToStaticMarkup(createElement(CommandError, {
      error: new Error("private implementation detail"),
      retry: vi.fn(),
    }));

    expect(html).toContain("This conversation could not open");
    expect(html).toContain("Retry Assistant");
    expect(html).toContain('href="/app"');
    expect(html).not.toContain("private implementation detail");
    expect(html).not.toContain("<main");
    expect(html).not.toContain("remain stored");
    expect(html).toContain("does not confirm whether pending work finished");
  });
});
