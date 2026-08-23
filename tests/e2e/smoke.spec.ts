import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import budgets from "../../performance-budgets.json";

const adminEmail = "playwright-admin@example.invalid";
const adminPassword = "playwright-local-only-password";
type BrowserCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];
let cachedSessionCookies: BrowserCookie[] = [];

async function signIn(page: Page) {
  if (cachedSessionCookies.length) {
    await page.context().addCookies(cachedSessionCookies);
    await page.goto("/onboarding");
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session");
      return (await response.json()) as {
        authenticated?: boolean;
      };
    }) as {
      authenticated?: boolean;
    };
    if (session.authenticated) {
      return;
    }
    cachedSessionCookies = [];
  }
  const login = await page.request.post("/api/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/onboarding$/);
  cachedSessionCookies = (await page.context().cookies()).filter(
    (cookie) => cookie.name === "omniagent_session",
  );
}

test("API performance telemetry stays observable and asynchronous", async ({
  request,
}) => {
  const session = await request.get("/api/auth/session");
  expect(session.ok()).toBeTruthy();
  expect(session.headers()["server-timing"]).toContain("db;dur=");
  expect(session.headers()["x-omni-db-queries"]).toMatch(/^\d+$/);
  expect(session.headers()["x-omni-db-writes"]).toMatch(/^\d+$/);

  const vital = await request.post("/api/observability/web-vitals", {
    data: {
      path: "/",
      metrics: [
        {
          id: "lcp-playwright",
          name: "LCP",
          value: 420,
          rating: "good",
        },
      ],
    },
  });
  expect(vital.status()).toBe(202);
});

test("landing stays within desktop and mobile browser budgets", async ({
  page,
}) => {
  type ReportedVital = {
    name: "CLS" | "FCP" | "INP" | "LCP";
    value: number;
  };
  let reported: ReportedVital[] = [];
  await page.exposeFunction("recordReportedVitals", (body: string) => {
    const payload = JSON.parse(body) as {
      path?: string;
      metrics?: ReportedVital[];
    };
    if (payload.path === "/") {
      reported.push(...(payload.metrics || []));
    }
  });
  await page.addInitScript(() => {
    const runtime = window as typeof window & {
      recordReportedVitals: (body: string) => Promise<void>;
      __omniagentWebVitalsSampleRate?: number;
    };
    runtime.__omniagentWebVitalsSampleRate = 1;
    const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      if (
        String(url).includes("/api/observability/web-vitals") &&
        typeof data === "string"
      ) {
        void runtime.recordReportedVitals(data);
        return true;
      }
      return nativeSendBeacon(url, data);
    };
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    reported = [];
    await page.setViewportSize(viewport);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(() => new Set(reported.map((metric) => metric.name)).size)
      .toBeGreaterThanOrEqual(4);
    const vitals = Object.fromEntries(
      reported.map((metric) => [metric.name, metric.value]),
    );
    expect(vitals.LCP).toBeGreaterThan(0);
    expect(vitals.LCP).toBeLessThanOrEqual(budgets.lcpMs);
    expect(vitals.INP).toBeLessThanOrEqual(budgets.inpMs);
    expect(vitals.CLS).toBeLessThanOrEqual(budgets.cls);
    await page.goto("/login", { waitUntil: "domcontentloaded" });
  }
});

test("homepage presents the private owner operating story responsively", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    if (viewport.width === 1440) {
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { name: "Skip to content" }),
      ).toBeFocused();
    }

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Give agents goals. Keep the controls.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "From goal to evidence, one connected flow.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Designed like an operations desk, not a chatbot.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Private by design. Observable by default.",
      }),
    ).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  for (const preference of ["light", "dark"] as const) {
    await page.evaluate((theme) => {
      window.localStorage.setItem("omniagent-theme", theme);
    }, preference);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      preference,
    );
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Give agents goals. Keep the controls.",
      }),
    ).toBeVisible();
  }

  const firstQuestion = page
    .locator("summary")
    .filter({ hasText: "What can OmniAgent do?" });
  await firstQuestion.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("It turns a goal into planned, observable work"),
  ).toBeVisible();
});

test("public and mobile application navigation stay usable", async ({ page }) => {
  await page.goto("/");
  const publicNavigation = page.getByRole("navigation", {
    name: "Public navigation",
  });
  await expect(publicNavigation).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Sign in" }).first(),
  ).toHaveAttribute("href", "/login");
  await expect(page.getByRole("link", { name: "Get access" })).toHaveCount(0);
  await expect(
    publicNavigation.getByRole("link", { name: "Pricing" }),
  ).toHaveCount(0);
  await publicNavigation.getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(/\/docs$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open public navigation" })
    .click();
  const publicMobileMenu = page.getByRole("navigation", {
    name: "Public navigation",
  });
  await expect(publicMobileMenu).toBeVisible();
  await expect(
    publicMobileMenu.getByRole("link", { name: "Sign in" }),
  ).toHaveAttribute("href", "/login");
  await expect(
    publicMobileMenu.getByRole("link", { name: "Pricing" }),
  ).toHaveCount(0);
  await publicMobileMenu.getByRole("link", { name: "Demo" }).click();
  await expect(page).toHaveURL(/\/demo$/);

  await signIn(page);
  await page.goto("/app");

  const mobileNavigation = page.getByRole("navigation", { name: "Primary workspace navigation" });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Runs" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Start" })).toBeVisible();
  await mobileNavigation.getByRole("link", { name: "Start" }).click();
  await expect(page).toHaveURL(/\/app\/command$/);
});

test("local bootstrap authentication rejects bad credentials and signs in", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByTestId("auth-story")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  const desktopHomeLink = page.getByRole("link", {
    name: "OmniAgentOS home",
  });
  const desktopHomeLinkBox = await desktopHomeLink.boundingBox();
  expect(desktopHomeLinkBox).not.toBeNull();
  expect(desktopHomeLinkBox?.height).toBeGreaterThanOrEqual(44);
  await page.getByLabel("Email address").fill(adminEmail);
  await page.locator("#password").fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.locator("form").getByRole("alert"),
  ).toContainText("Email or password is incorrect");

  await page.locator("#password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
});

test("local development login keeps a level-one heading and direct workspace action", async ({
  page,
}) => {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authEnabled: false,
        authenticated: false,
      }),
    });
  });
  await page.goto("/login");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Local development mode",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open workspace" }),
  ).toHaveAttribute("href", "/app");
});

test("private login is form-first, theme-aware, and rate-limit safe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Too Many Requests",
        message: "Too many login attempts. Try again later.",
      }),
    });
  });
  await page.goto("/login");

  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(page.getByTestId("auth-story")).toBeHidden();
  await expect(page.getByTestId("login-form")).toBeVisible();
  await expect(
    page.getByText("Private workspace · No public registration"),
  ).toBeVisible();

  const initialPreference = await page
    .locator("html")
    .getAttribute("data-theme-preference");
  await page.getByRole("button", { name: /^Theme:/ }).click();
  const changedPreference = await page
    .locator("html")
    .getAttribute("data-theme-preference");
  expect(changedPreference).not.toBe(initialPreference);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preference",
    changedPreference || "system",
  );

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByTestId("auth-story")).toBeHidden();
    await expect(page.getByTestId("login-form")).toBeVisible();
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  await page.getByLabel("Email address").fill(adminEmail);
  await page
    .getByLabel("Password", { exact: true })
    .fill("rate-limited-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("login-form").getByRole("alert")).toContainText(
    "Too many sign-in attempts. Try again shortly.",
  );
});

test("command palette supports keyboard search, navigation, and escape", async ({ page }) => {
  await signIn(page);
  await page.goto("/app");

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Go to a workspace" });
  await expect(palette).toBeVisible();

  const search = page.getByRole("combobox", { name: "Search workspaces" });
  await expect(search).toBeFocused();
  await search.press("Tab");
  await expect(page.getByRole("button", { name: "Close command palette" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await search.fill("results");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(page).toHaveURL(/\/app\/results$/);

  const trigger = page.getByTestId("command-palette-trigger");
  await trigger.click();
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("agent work streams a clearly labeled fallback into results", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/command");
  await page
    .getByRole("textbox", { name: /^Task outcome/ })
    .fill("Summarize the release posture without making external changes.");
  const startedAt = Date.now();
  await page.getByRole("button", { name: "Run task" }).click();
  const executionPanel = page.getByRole("tabpanel");
  await expect(
    executionPanel.getByText("status", { exact: true }).first(),
  ).toBeVisible();
  expect(Date.now() - startedAt).toBeLessThan(budgets.firstSseStatusMs);
  await expect(executionPanel).toContainText("[Simulated response]");
  expect(Date.now() - startedAt).toBeLessThan(
    budgets.completionVisibilityMs,
  );
  await expect(executionPanel).toContainText(
    "OPENAI_API_KEY is not configured, so no model ran.",
  );

  await page.getByRole("tab", { name: "Result" }).click();
  const resultsLink = page.getByRole("link", { name: "Open Results" });
  await expect(resultsLink).toHaveAttribute(
    "href",
    /\/app\/results\?run=agent%3A/,
  );
  await resultsLink.click();
  await expect(page).toHaveURL(/\/app\/results\?run=agent%3A/);
});

test("Start avoids admin evidence requests on its critical path", async ({
  page,
}) => {
  await signIn(page);
  const adminRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname === "/api/release/evidence" ||
      pathname === "/api/observability"
    ) {
      adminRequests.push(pathname);
    }
  });

  await page.goto("/app/command");
  await expect(
    page.getByRole("textbox", { name: /^Task outcome/ }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(adminRequests).toEqual([]);
});

test("workspace summary panels settle independently", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/workspace-summary?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        summary: {
          tenantId: "playwright",
          generatedAt: new Date().toISOString(),
          sources: {
            runs: {
              status: "ready",
              data: [
                {
                  id: "run-independent",
                  mode: "research",
                  status: "completed",
                  prompt: "Independent panel result",
                  response: "Loaded while workflows failed.",
                  startedAt: new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                },
              ],
            },
            workflows: {
              status: "error",
              error: "Workflow source is temporarily slow.",
            },
            approvals: { status: "ready", data: [] },
          },
        },
      }),
    });
  });

  await page.goto("/app");
  await expect(
    page.getByText("Independent panel result").first(),
  ).toBeVisible();
  await expect(
    page.getByText("Workflow source is temporarily slow."),
  ).toBeVisible();
});

test("reviewed workflow plans bind to one visible run", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/command");

  await page.getByRole("textbox", { name: /^Task outcome/ }).fill(
    "Summarize recent workflow evidence and produce a bounded verification report.",
  );
  await page.getByRole("button", { name: "Preview plan" }).click();
  await expect(
    page.getByRole("heading", { name: "Workflow plan" }),
  ).toBeVisible();

  const start = page.getByRole("button", { name: "Start reviewed plan" });
  await expect(start).toBeEnabled();
  await start.click();

  await expect(page.getByRole("link", { name: "Manage workflow" })).toBeVisible();
  await page.getByRole("tab", { name: "Plan" }).click();
  await expect(page.getByRole("button", { name: "Workflow started" })).toBeDisabled();
  await expect(
    page.getByText(
      /Workflow (queued|running|completed|paused|failed|canceled)|Approval required/,
    ).first(),
  ).toBeVisible();
});

test("mobile workspace menu reaches advanced routes and signs out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/app");

  await page.getByTestId("workspace-menu-trigger").click();
  const menu = page.getByTestId("workspace-mobile-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("link", { name: "Security" }).click();
  await expect(page).toHaveURL(/\/app\/security$/);
  await expect(page.locator("#workspace-content")).toBeFocused();

  await page.getByTestId("workspace-menu-trigger").click();
  await page
    .getByTestId("workspace-mobile-menu")
    .getByRole("link", { name: "Security" })
    .click();
  await expect(page.getByTestId("workspace-mobile-menu")).toBeHidden();
  await expect(page.locator("#workspace-content")).toBeFocused();

  await page.getByTestId("workspace-menu-trigger").click();
  await page.getByTestId("workspace-mobile-menu").getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("public signup redirects to private login and intake is closed", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/onboarding/request-access", {
    data: {
      name: "Ada Operator",
      email: "ada@example.com",
      company: "Private Workspace",
      role: "engineering",
      timeline: "now",
      useCase: "Operate a governed private agent workspace.",
    },
  });
  expect(response.status()).toBe(404);

  const signupResponse = await request.get("/signup", { maxRedirects: 0 });
  expect(signupResponse.status()).toBe(308);
  expect(signupResponse.headers()["location"]).toBe("/login");

  await page.goto("/signup");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("new connector contracts stay quarantined until reviewed in place", async ({ page }) => {
  await signIn(page);
  const connectorName = `Reviewed inventory API ${crypto.randomUUID().slice(0, 8)}`;
  const specText = JSON.stringify({
    openapi: "3.0.3",
    info: { title: connectorName, version: "1.0.0" },
    servers: [{ url: "https://8.8.8.8" }],
    paths: {
      "/inventory": {
        get: {
          operationId: "listInventory",
          summary: "List inventory",
          responses: { "200": { description: "Inventory list" } },
        },
      },
    },
  });
  const created = await page.evaluate(
    async ({ name, spec }) => {
      const response = await fetch("/api/openapi-connectors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          specText: spec,
          authType: "none",
          defaultRiskLevel: 0,
          approvalRequired: false,
          importSpec: true,
        }),
      });
      return {
        status: response.status,
        body: await response.json(),
      };
    },
    { name: connectorName, spec: specText },
  );
  expect(created.status).toBe(201);
  expect(created.body.connector.review).toMatchObject({ pendingCount: 1 });
  expect(created.body.operations).toEqual([
    expect.objectContaining({
      operationId: "listInventory",
      status: "pending_review",
    }),
  ]);

  await page.goto("/app/connectors");
  await expect(
    page.getByRole("heading", { name: "Contract review queue" }),
  ).toBeVisible();
  const reviewCard = page.getByRole("article", {
    name: `${connectorName} OpenAPI contract review`,
  });
  await expect(reviewCard.getByText("GET /inventory")).toBeVisible();
  await expect(
    reviewCard.getByText(/risk 0 · no per-call approval/),
  ).toBeVisible();

  await reviewCard
    .getByRole("button", { name: "Approve and activate connector" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({
        hasText:
          "Approved 1 exact OpenAPI contract and activated the connector.",
      }),
  ).toBeVisible();
  await expect(reviewCard).toBeHidden();

  const reviewed = await page.evaluate(async () => {
    const response = await fetch("/api/openapi-connectors");
    return response.json();
  });
  const connector = reviewed.connectors.find(
    (item: { name?: string }) => item.name === connectorName,
  );
  const operation = reviewed.operations.find(
    (item: { connectorId?: string }) => item.connectorId === connector?.id,
  );
  expect(operation).toMatchObject({
    operationId: "listInventory",
    status: "active",
  });
  expect(connector).toMatchObject({ status: "active" });
});
