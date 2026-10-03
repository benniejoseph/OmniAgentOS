import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoWorkspace } from "./demo-workspace";

describe("public simulation", () => {
  it("labels sample data and review stages without offering authorization or claiming live evidence", () => {
    const html = renderToStaticMarkup(createElement(DemoWorkspace));
    expect(html).toContain("Demo workspace · Simulated");
    expect(html).toContain("does not run work or grant permission");
    expect(html).toContain("Fictional example");
    expect(html).toContain("Not performed");
    expect(html).toContain('role="group" aria-label="Simulation steps"');
    expect((html.match(/aria-pressed="true"/g) ?? [])).toHaveLength(1);
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("Run sample agent");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("passed");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('href="/signup"');
  });
});
