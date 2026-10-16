import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserAlerts } from "./browser-alerts";

afterEach(() => vi.unstubAllGlobals());

it("keeps the server snapshot neutral until hydration detects browser support", () => {
  const render = () => renderToString(createElement(BrowserAlerts, { active: true, ownerKey: "synthetic-owner" }));
  const server = render();
  vi.stubGlobal("window", { Notification: {}, PushManager: {} });
  vi.stubGlobal("navigator", { serviceWorker: {} });
  const withBrowserApis = render();
  expect(server).toBe(withBrowserApis);
  expect(server).toContain("Checking browser notification support");
  expect(server).not.toContain("This browser does not support");
  expect(server).not.toContain("Enable browser alerts</button>");
});
