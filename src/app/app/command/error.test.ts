import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import CommandError from "@/app/app/command/error";

describe("Command error recovery", () => {
  it("keeps recovery inside the app with a retry and safe exit", () => {
    const html = renderToStaticMarkup(createElement(CommandError, {
      error: new Error("private implementation detail"),
      reset: vi.fn(),
    }));

    expect(html).toContain("The conversation is still safe");
    expect(html).toContain("Retry Command");
    expect(html).toContain('href="/app"');
    expect(html).not.toContain("private implementation detail");
  });
});
