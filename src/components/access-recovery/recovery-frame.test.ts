import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PageError from "@/app/error";
import GlobalError from "@/app/global-error";
import WorkspaceError from "@/app/app/error";
import CommandError from "@/app/app/command/error";
import MissionsLoading from "@/app/app/missions/loading";
import NotFound from "@/app/not-found";

describe("truthful recovery boundaries", () => {
  for (const [name, Boundary] of [["page", PageError], ["root", GlobalError], ["workspace", WorkspaceError], ["assistant", CommandError]] as const) {
    it(`${name} exposes an escaped reference without exposing the private error or inventing stored results`, () => {
      const error = Object.assign(new Error("private account content and implementation detail"), { digest: "reference/<untrusted>&long:identity" });
      const html = renderToStaticMarkup(createElement(Boundary, { error, retry: () => undefined }));
      expect(html).toContain("Error reference:");
      expect(html).toContain("reference/&lt;untrusted&gt;&amp;long:identity");
      expect(html).not.toContain(error.message);
      expect(html).not.toContain("Nothing you saved was lost");
      expect(html).not.toContain("conversation is still safe");
      expect(html).not.toContain("work remain stored");
      expect((html.match(/<h1\b/g) ?? [])).toHaveLength(1);
    });
  }

  it("announces a mission read without implying that missions are running", () => {
    const html = renderToStaticMarkup(createElement(MissionsLoading));
    expect(html).toContain('role="status" aria-busy="true"');
    expect(html).toContain("Mission status is not available yet");
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("<button");
  });

  it("offers bounded 404 destinations without echoing an untrusted request URL", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain("404 · Page not found");
    expect(html).toContain("This address has no page");
    expect(html).toContain('href="/app"');
    expect(html).toContain('href="/"');
    expect(html).not.toContain('href="/signup"');
  });
});
