import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import OfflinePage from "@/app/offline/page";

describe("offline page", () => {
  it("promises only what works without a connection", () => {
    const html = renderToStaticMarkup(createElement(OfflinePage));

    expect(html).toContain("You are offline.");
    expect(html).toContain("A Capture page that is already open still saves notes on this device");
    expect(html).toContain('href="/app"');
    // Capture cannot open while offline; the worker would show this page again.
    expect(html).not.toContain('href="/app/capture"');
    expect(html).not.toContain("still works offline");
  });
});
