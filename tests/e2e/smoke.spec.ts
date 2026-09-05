import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import budgets from "../../performance-budgets.json";

const adminEmail = "playwright-admin@example.invalid";
const adminPassword = "playwright-local-only-password";
type BrowserCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];
let cachedSessionCookies: BrowserCookie[] = [];

async function signIn(page: Page) {
  const sessionCachePath = process.env.OMNIAGENT_E2E_SESSION_FILE;
  if (!cachedSessionCookies.length && sessionCachePath) {
    cachedSessionCookies = await readFile(sessionCachePath, "utf8")
      .then((contents) => JSON.parse(contents) as BrowserCookie[])
      .catch(() => []);
  }
  if (cachedSessionCookies.length) {
    await page.context().addCookies(cachedSessionCookies);
    await page.goto("/app");
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
    if (sessionCachePath) {
      await unlink(sessionCachePath).catch(() => undefined);
    }
  }
  const login = await page.request.post("/api/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto("/app");
  await expect(page).toHaveURL(/\/app$/);
  cachedSessionCookies = (await page.context().cookies()).filter(
    (cookie) => cookie.name === "asael_session" || cookie.name === "__Host-asael_session",
  );
  if (sessionCachePath) {
    await mkdir(dirname(sessionCachePath), { recursive: true });
    await writeFile(sessionCachePath, JSON.stringify(cachedSessionCookies), "utf8");
  }
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
      window.localStorage.setItem("asael-theme", theme);
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
    .filter({ hasText: "What can Asael do?" });
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

  const mobileNavigation = page.getByRole("navigation", { name: "Everyday workspace navigation" });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.getByRole("link")).toHaveCount(5);
  await expect(mobileNavigation.getByRole("link", { name: "Today" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Command" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Capture" })).toBeVisible();
  await page.getByRole("button", { name: "Open workspace menu" }).click();
  await expect(page.getByRole("navigation", { name: "Complete workspace navigation" }).getByRole("link", { name: "Inbox" })).toBeVisible();
  await page.getByRole("button", { name: "Close workspace menu" }).last().click();
  await mobileNavigation.getByRole("link", { name: "Command" }).click();
  await expect(page).toHaveURL(/\/app\/command$/);
});

test("capture inbox queues a note and a text file", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/capture", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Turn anything worth keeping into usable context." })).toBeVisible();

  await page.getByLabel("Note", { exact: true }).fill("The weekly review happens every Friday afternoon.");
  await page.getByLabel("Title").fill("Weekly review cadence");
  await page.getByRole("button", { name: "Store and index" }).click();
  await expect(page.getByText(/Weekly review cadence.*stored and queued for indexing/)).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("capture-file-input").setInputFiles({
    name: "project-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Project notes\n\nUse source-backed answers."),
  });
  await expect(page.getByText("project-notes.md")).toBeVisible();
  await page.getByRole("button", { name: "Store and index" }).click();
  await expect(page.getByText(/project notes.*stored and queued for indexing/i)).toBeVisible({ timeout: 20_000 });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("memory studio creates, inspects, corrects, and forgets a claim", async ({ page }) => {
  test.slow();
  await signIn(page);
  await page.goto("/app/memory");
  await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Knowledge graph" })).toBeVisible();

  await page.getByRole("button", { name: "Add memory" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a memory" });
  await dialog.getByLabel("Title").fill("Preferred briefing style");
  await dialog.getByLabel("What should your agents know?").fill("Lead with the decision, then show compact evidence.");
  await dialog.getByRole("button", { name: "Save memory" }).click();

  const inspector = page.locator(".memory-inspector");
  await expect(inspector.getByRole("heading", { name: "Preferred briefing style" })).toBeVisible();
  await inspector.getByLabel("Claim").fill("Lead with the recommendation, then show compact evidence.");
  await inspector.getByRole("button", { name: "Save correction" }).click();
  await expect(inspector.getByRole("button", { name: "Corrected" })).toBeVisible();

  await inspector.getByRole("button", { name: "Review forget impact" }).click();
  await expect(
    inspector.getByRole("region", { name: "Permanent deletion preview" }),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Forget permanently" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Best-effort local deletion" }),
  ).toBeVisible();
});

test("agent arsenal stays navigable across themes and viewports", async ({ page }) => {
  test.slow();
  await signIn(page);
  for (const [index, viewport] of [{ width: 1440, height: 900 }, { width: 390, height: 844 }].entries()) {
    await page.setViewportSize(viewport);
    await page.goto("/app/agents", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Your Arsenal" })).toBeVisible();
    await page.getByRole("navigation", { name: "Agent roster" }).getByRole("button", { name: /Scout, Research/ }).click();
    await expect(page.getByRole("heading", { name: "Scout" })).toBeVisible();
    await expect(page.getByText("Reads broadly, never performs external mutations.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (index === 0) {
      await page.getByRole("link", { name: "Assign work to Scout" }).click();
      await expect(page).toHaveURL(/\/app\/command\?agent=scout$/);
      await expect(page.getByText("Working with Scout")).toBeVisible();
      await page.goto("/app/agents", { waitUntil: "networkidle" });
    }
  }
  await page.evaluate(() => localStorage.setItem("asael-theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("navigation", { name: "Agent roster" }).getByRole("button", { name: /Atlas, Supervisor/ })).toBeVisible();
});

test("Today captures and reversibly completes a focus item", async ({ page }) => {
  const taskTitle = "Prepare the personal weekly review";
  const hydrationRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      (url.pathname === "/api/today" || url.pathname === "/api/workspace-summary")
    ) {
      hydrationRequests.push(url.pathname);
    }
  });
  await signIn(page);
  await expect(page.getByText(/items? needs? your attention|Everything is clear/)).toBeVisible();
  await page.waitForTimeout(250);
  expect(hydrationRequests).toEqual([]);
  await page.getByLabel("Add a focus item").fill(taskTitle);
  await page.getByLabel("Priority").selectOption("high");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const focusItem = page.locator(".today-focus-list .today-focus-item").filter({ hasText: taskTitle }).last();
  await expect(focusItem).toBeVisible();
  const dailyBrief = page.locator(".today-generated-brief");
  await expect(dailyBrief.getByRole("heading", { name: "Daily brief" })).toBeVisible();
  const briefAction = dailyBrief.getByRole("button", { name: /Generate brief|Refresh/ });
  await expect(briefAction).toBeVisible();
  await briefAction.click();
  await expect(dailyBrief).toContainText(taskTitle);
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/api/today/") &&
      response.request().method() === "PATCH" &&
      response.ok(),
    ),
    focusItem.click(),
  ]);
  await expect(focusItem).toHaveClass(/is-done/);
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/api/today/") &&
      response.request().method() === "PATCH" &&
      response.ok(),
    ),
    focusItem.click(),
  ]);
  await expect(focusItem).not.toHaveClass(/is-done/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".today-focus-list").getByText(taskTitle, { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Today hydrates timestamp labels in a non-UTC browser", async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    timezoneId: "Asia/Kolkata",
  });
  const page = await context.newPage();
  const hydrationErrors: string[] = [];
  const captureHydrationError = (message: string) => {
    if (
      /Minified React error #418|hydration failed|server rendered text didn't match/i.test(
        message,
      )
    ) {
      hydrationErrors.push(message);
    }
  };
  page.on("console", (message) => {
    if (message.type() === "error") captureHydrationError(message.text());
  });
  page.on("pageerror", (error) => captureHydrationError(error.message));

  try {
    await signIn(page);
    const briefPayload = await page.evaluate(async () => {
      const response = await fetch("/api/today/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      if (!response.ok) {
        throw new Error(`brief generation returned ${response.status}`);
      }
      return response.json();
    }) as {
      brief?: { generatedAt?: string };
    };
    const generatedAt = briefPayload.brief?.generatedAt;
    expect(generatedAt).toBeTruthy();

    hydrationErrors.length = 0;
    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.locator('[data-testid="activity-workspace"][data-hydrated="true"]'),
    ).toBeVisible();
    await expect(page.locator(".today-brief-meta time")).toHaveAttribute(
      "datetime",
      generatedAt || "",
    );
    expect(hydrationErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("notification center delivers and completes an actionable reminder", async ({ browser, baseURL }) => {
  test.slow();
  const context = await browser.newContext({
    baseURL,
    timezoneId: "Asia/Kolkata",
  });
  const page = await context.newPage();
  const title = `Review the private brief ${crypto.randomUUID().slice(0, 6)}`;
  try {
    await signIn(page);
    await page.goto("/app", { waitUntil: "networkidle" });

    await page.getByRole("button", { name: /^Notifications/ }).click();
    let dialog = page.getByRole("dialog", { name: "Notifications" });
    await expect(dialog).toBeVisible();
    await dialog.getByText("Delivery settings", { exact: true }).click();
    const quietHours = dialog.getByLabel(/^Quiet hours/);
    if (await quietHours.isChecked()) await quietHours.uncheck();
    const reminderLead = dialog.getByLabel("Reminder lead");
    const nextReminderLead = await reminderLead.inputValue() === "15" ? "60" : "15";
    await reminderLead.selectOption(nextReminderLead);
    await Promise.all([
      page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/today/brief" &&
        response.request().method() === "PATCH" &&
        response.ok(),
      ),
      dialog.getByRole("button", { name: "Save settings" }).click(),
    ]);
    await dialog.getByRole("button", { name: "Close notifications" }).click();

    const persistedSettingsResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/notifications" &&
      response.request().method() === "GET" &&
      response.ok(),
    );
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const persistedSettings = await (await persistedSettingsResponse).json() as {
      preferences?: { reminderLeadMinutes?: number };
    };
    expect(persistedSettings.preferences?.reminderLeadMinutes)
      .toBe(Number(nextReminderLead));
    dialog = page.getByRole("dialog", { name: "Notifications" });
    await dialog.getByText("Delivery settings", { exact: true }).click();
    await expect(dialog.getByLabel("Reminder lead")).toHaveValue(nextReminderLead);
    await dialog.getByRole("button", { name: "Close notifications" }).click();

    const due = await page.evaluate(() => {
      const date = new Date(Date.now() - 60_000);
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
      const localValue = local.toISOString().slice(0, 16);
      return {
        localValue,
        expectedIso: new Date(localValue).toISOString(),
        timezoneOffsetMinutes: date.getTimezoneOffset(),
      };
    });
    expect(due.timezoneOffsetMinutes).toBe(-330);
    await page.getByLabel("Add a focus item").fill(title);
    await page.getByLabel("Item type").selectOption("reminder");
    // Reproduce native date-picker/assistive input that updates the DOM control
    // immediately before React's controlled state has synchronized.
    await page.getByLabel("Due time").evaluate((element, value) => {
      (element as HTMLInputElement).value = value;
    }, due.localValue);
    const createResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/today" &&
      response.request().method() === "POST" &&
      response.ok(),
    );
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const createPayload = await (await createResponsePromise).json() as {
      item?: { dueAt?: string };
    };
    expect(createPayload.item?.dueAt).toBe(due.expectedIso);

    const tick = await page.request.get("/api/workflows/tick", {
      headers: {
        authorization: "Bearer playwright-local-only-cron-secret",
      },
    });
    expect(tick.ok()).toBeTruthy();

    const refreshedNotifications = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/notifications" &&
      response.request().method() === "GET" &&
      response.ok(),
    );
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await refreshedNotifications;
    dialog = page.getByRole("dialog", { name: "Notifications" });
    const reminder = dialog.getByRole("article").filter({ hasText: title });
    await expect(reminder).toBeVisible();
    await expect(reminder).toContainText("Overdue");
    await reminder.getByRole("button", { name: "Complete" }).click();
    await expect(dialog.getByText("Recent history")).toBeVisible();
    await expect(dialog.locator(".notification-history")).toContainText(title);
    await expect(dialog.locator(".notification-history")).toContainText("Completed");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /^Notifications/ })).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /^Notifications/ }).click();
    dialog = page.getByRole("dialog", { name: "Notifications" });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});

test("Projects persists an Atlas plan and guarded task progress", async ({ page }) => {
  test.slow();
  const projectTitle = `Build a private agent system ${crypto.randomUUID().slice(0, 6)}`;
  await signIn(page);
  await page.goto("/app/projects", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.locator(".projects-create-button").click();
  await page.getByLabel("Project name").fill(projectTitle);
  await page.getByLabel("Successful outcome").fill("A repeatable agent workflow completes bounded work with evidence and review.");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectTitle })).toBeVisible();

  await page.getByRole("button", { name: "Plan with Atlas" }).click();
  await expect(page.getByText("Atlas added a plan")).toBeVisible();
  const tasks = page.locator(".project-task-list .project-task");
  await expect(tasks).toHaveCount(5);
  await expect(page.locator(".project-task-list")).toContainText("Scout");
  await expect(page.locator(".project-task-list")).toContainText("Forge");
  await expect(page.locator(".project-task-list")).toContainText("Sentinel");

  const firstTask = tasks.first();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/tasks/") && response.request().method() === "PATCH" && response.ok()),
    firstTask.getByRole("button", { name: /^Start / }).click(),
  ]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(firstTask).toHaveClass(/is-doing/);
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/tasks/") && response.request().method() === "PATCH" && response.ok()),
    firstTask.getByRole("button", { name: /^Complete / }).click(),
  ]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(firstTask).toHaveClass(/is-done/);
  await expect(firstTask.getByRole("link", { name: /^Assign / })).toHaveAttribute("href", /\/app\/command\?agent=atlas&prompt=/);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: projectTitle })).toBeVisible();
  await expect(page.locator(".project-task-list .project-task").first()).toHaveClass(/is-done/);
  await expect(page.getByRole("heading", { name: "Ready for deployment" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verified work becomes memory" })).toBeVisible();
  await expect(page.getByText("No verified outputs yet")).toBeVisible();
  await page.getByLabel("Operating mode").selectOption("autonomous");
  await page.getByLabel("Task budget").fill("3");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/execution") && response.request().method() === "POST" && response.ok()),
    page.getByRole("button", { name: "Start agents" }).click(),
  ]);
  await expect(page.locator(".project-execution-deck")).toHaveClass(/is-running|is-waiting_approval/);
  await expect(page.locator(".project-task-live, .project-task-action").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Missions creates a durable outcome without exposing executor internals", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/missions", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Missions" })).toBeVisible();

  await page.getByRole("button", { name: "New mission" }).first().click();
  const title = `Mission QA ${Date.now().toString(36)}`;
  await page.getByRole("textbox", { name: "Mission title" }).fill(title);
  await page.getByRole("textbox", { name: "Observable outcome" }).fill("Produce a concise operating brief with evidence receipts.");
  const missionRouteReloads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/app/missions/") &&
      (request.resourceType() === "document" ||
        request.headers().rsc === "1" ||
        url.searchParams.has("_rsc"))
    ) {
      missionRouteReloads.push(request.url());
    }
  });
  await page.getByRole("button", { name: "Create draft" }).click();

  await expect(page).toHaveURL(/\/app\/missions\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page).toHaveURL(/\/app\/missions$/);
  await page.evaluate(() => window.history.forward());
  await expect(page).toHaveURL(/\/app\/missions\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  expect(missionRouteReloads).toEqual([]);
  await expect(page.getByText("Ledger live", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Board" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Canvas" })).toBeVisible();
  await expect(page.getByRole("button", { name: "List" })).toBeVisible();

  const detailIsSafe = await page.evaluate(async () => {
    const response = await fetch(window.location.pathname.replace("/app/", "/api/"));
    const body = await response.text();
    return response.ok && !body.includes("fenceToken") && !body.includes("sourceKey");
  });
  expect(detailIsSafe).toBe(true);

  const hydrationRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) hydrationRequests.push(pathname);
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  expect(hydrationRequests).not.toContain("/api/auth/session");
  expect(hydrationRequests).not.toContain(
    page.url().replace(/^.*\/app\/missions\//, "/api/missions/"),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("local bootstrap authentication rejects bad credentials and signs in", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByTestId("auth-story")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  const desktopHomeLink = page.getByRole("link", {
    name: "Asael home",
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
  await expect(page).toHaveURL(/\/app$/);
});

test("retired onboarding redirects", async ({ page, request }) => {
  test.slow();
  const response = await request.get("/onboarding", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe("/app");
  await signIn(page);
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/app$/);
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

  await page.getByRole("group", { name: "Color theme" }).getByTitle("Use dark theme").click();
  const changedPreference = "dark";
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

  await expect(page.getByTestId("command-palette-trigger")).toBeVisible();
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
  await expect(palette.getByRole("option", { name: /^Results/ })).toHaveAttribute("aria-selected", "true");
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
  test.slow();
  await signIn(page);
  await page.goto("/app/command");
  // Local Playwright runs use the Next development server. Warm both route
  // modules so this assertion measures application latency, not compilation.
  await page.evaluate(async () => {
    await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Warm the agent route." }] }),
    }).then((response) => response.text());
  });
  await page
    .getByRole("textbox", { name: "Message Asael" })
    .fill("Summarize the release posture without making external changes.");
  const startedAt = Date.now();
  await page.getByRole("button", { name: "Send message" }).click();
  const runAnnouncement = page.locator('p[role="status"][aria-live="polite"]').first();
  await expect(runAnnouncement).toContainText(/Starting|Agent run/);
  expect(Date.now() - startedAt).toBeLessThan(budgets.firstSseStatusMs);
  const workspace = page.getByTestId("work-workspace");
  await expect(workspace).toContainText("[Simulated response]");
  expect(Date.now() - startedAt).toBeLessThan(
    budgets.completionVisibilityMs,
  );
  await expect(workspace).toContainText(
    "OPENAI_API_KEY is not configured, so no model ran.",
  );

  await workspace.getByRole("button", { name: "Needs work" }).click();
  await workspace
    .getByLabel("What should change next time?")
    .fill("Lead with the recommendation and make the evidence easier to scan.");
  await workspace.getByRole("button", { name: "Save feedback" }).click();
  await expect(workspace.getByText(/Correction saved/)).toBeVisible();
  await workspace.getByRole("button", { name: "Useful" }).click();
  await expect(workspace.getByText(/Useful outcome saved/)).toBeVisible();

  await page.getByRole("button", { name: /Evidence/ }).click();
  await expect(page.getByRole("tab", { name: "Result" })).toHaveAttribute("aria-selected", "true");
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
    page.getByRole("textbox", { name: "Message Asael" }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(adminRequests).toEqual([]);
});

test("dashboard presents dismissible first-run readiness without blocking work", async ({ page }) => {
  test.slow();
  await signIn(page);
  await page.route("**/api/workspace-readiness", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        checks: {
          identity: true,
          knowledge: false,
          connector: false,
          firstRun: false,
          evaluation: false,
        },
        completedCount: 1,
        totalCount: 5,
        firstSuccessfulRun: false,
      }),
    }),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Get your workspace ready" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start first task" })).toHaveAttribute("href", "/app/command");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByRole("button", { name: "Dismiss setup for now" }).click();
  const reopen = page.getByRole("button", { name: "Open setup and readiness" });
  await expect(reopen).toBeVisible();
  await expect(reopen).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("asael.workspace-readiness.compact.v1"),
    ),
  ).toBe("1");

  await page.reload();
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(page.getByRole("heading", { name: "Get your workspace ready" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss setup for now" })).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("asael.workspace-readiness.compact.v1"),
    ),
  ).toBeNull();
});

test("persisted readiness dismissal survives failed reload", async ({ page }) => {
  test.slow();
  await signIn(page);
  await page.evaluate(() => {
    window.localStorage.setItem(
      "asael.workspace-readiness.compact.v1",
      "1",
    );
  });
  await page.route("**/api/workspace-readiness", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Service Unavailable",
        message: "Readiness remains temporarily unavailable.",
      }),
    }),
  );

  await page.goto("/app");
  const reopen = page.getByRole("button", { name: "Open setup and readiness" });
  await expect(reopen).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Setup readiness could not be loaded" }),
  ).toBeHidden();

  await reopen.click();
  await expect(
    page.getByRole("alert").filter({
      has: page.getByRole("button", { name: "Retry" }),
    }),
  ).toContainText(
    "Readiness remains temporarily unavailable.",
  );
  await expect(page.getByTestId("workspace-readiness-focus")).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("asael.workspace-readiness.compact.v1"),
    ),
  ).toBeNull();
});

test("dashboard keeps readiness compact after first success", async ({ page }) => {
  test.slow();
  await signIn(page);
  await page.route("**/api/workspace-readiness", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        checks: {
          identity: true,
          knowledge: true,
          connector: true,
          firstRun: true,
          evaluation: false,
        },
        completedCount: 4,
        totalCount: 5,
        firstSuccessfulRun: true,
      }),
    }),
  );

  await page.goto("/app");
  const reopen = page.getByRole("button", { name: "Open setup and readiness" });
  await expect(reopen).toBeVisible();
  await expect(page.getByRole("heading", { name: "Get your workspace ready" })).toBeHidden();
  await reopen.click();
  await expect(page.getByRole("heading", { name: "Get your workspace ready" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss setup for now" })).toBeFocused();
});

test("readiness failure leaves dashboard usable", async ({ page }) => {
  test.slow();
  let requests = 0;
  await signIn(page);
  await page.route("**/api/workspace-readiness", (route) => {
    requests += 1;
    return route.fulfill({
      status: requests === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        requests === 1
          ? {
              error: "Service Unavailable",
              message: "Readiness is temporarily unavailable.",
            }
          : {
              generatedAt: new Date().toISOString(),
              checks: {
                identity: true,
                knowledge: false,
                connector: false,
                firstRun: false,
                evaluation: false,
              },
              completedCount: 1,
              totalCount: 5,
              firstSuccessfulRun: false,
            },
      ),
    });
  });

  await page.goto("/app");
  const readinessAlert = page.getByRole("alert").filter({
    has: page.getByRole("button", { name: "Retry" }),
  });
  await expect(readinessAlert).toContainText("Readiness is temporarily unavailable.");
  await expect(
    page
      .getByTestId("activity-workspace")
      .getByRole("link", { name: "Start task", exact: true }),
  ).toHaveAttribute("href", "/app/command");
  await readinessAlert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("workspace-readiness-focus")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Get your workspace ready" })).toBeVisible();
});

test("readiness rejects malformed success and recovers", async ({ page }) => {
  test.slow();
  await signIn(page);
  let requests = 0;
  await page.route("**/api/workspace-readiness", (route) => {
    requests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        requests === 1
          ? { generatedAt: new Date().toISOString(), checks: null }
          : {
              generatedAt: new Date().toISOString(),
              checks: {
                identity: true,
                knowledge: false,
                connector: false,
                firstRun: false,
                evaluation: false,
              },
              completedCount: 1,
              totalCount: 5,
              firstSuccessfulRun: false,
            },
      ),
    });
  });

  await page.goto("/app");
  const readinessAlert = page.getByRole("alert").filter({
    has: page.getByRole("button", { name: "Retry" }),
  });
  await expect(readinessAlert).toContainText("Readiness response was invalid.");
  await expect(
    page
      .getByTestId("activity-workspace")
      .getByRole("link", { name: "Start task", exact: true }),
  ).toHaveAttribute("href", "/app/command");
  await readinessAlert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("workspace-readiness-focus")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Get your workspace ready" })).toBeVisible();
});

test("readiness preserves stale data and can compact after refresh failure", async ({ page }) => {
  test.slow();
  await signIn(page);
  let requests = 0;
  await page.route("**/api/workspace-readiness", (route) => {
    requests += 1;
    return route.fulfill({
      status: requests === 1 ? 200 : 503,
      contentType: "application/json",
      body: JSON.stringify(
        requests === 1
          ? {
              generatedAt: new Date().toISOString(),
              checks: {
                identity: true,
                knowledge: false,
                connector: false,
                firstRun: false,
                evaluation: false,
              },
              completedCount: 1,
              totalCount: 5,
              firstSuccessfulRun: false,
            }
          : {
              error: "Service Unavailable",
              message: "Readiness refresh is temporarily unavailable.",
            },
      ),
    });
  });

  await page.goto("/app");
  await expect(page.getByText("1 of 5 readiness checks complete.")).toBeVisible();
  await page.getByRole("button", { name: "Refresh setup" }).click();
  const readinessAlert = page.getByRole("alert").filter({
    has: page.getByRole("button", { name: "Retry" }),
  });
  await expect(readinessAlert).toContainText(
    "Readiness refresh is temporarily unavailable.",
  );
  await expect(page.getByText("1 of 5 readiness checks complete.")).toBeVisible();

  await page.getByRole("button", { name: "Dismiss setup for now" }).click();
  const reopen = page.getByRole("button", { name: "Open setup and readiness" });
  await expect(reopen).toBeVisible();
  await expect(reopen).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("asael.workspace-readiness.compact.v1"),
    ),
  ).toBe("1");
});

test("readiness stays outside recurring dashboard refresh", async ({ page }) => {
  test.slow();
  await signIn(page);
  let readinessRequests = 0;
  let summaryRequests = 0;
  await page.route("**/api/workspace-readiness", (route) => {
    readinessRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        checks: {
          identity: true,
          knowledge: false,
          connector: false,
          firstRun: false,
          evaluation: false,
        },
        completedCount: 1,
        totalCount: 5,
        firstSuccessfulRun: false,
      }),
    });
  });
  await page.route("**/api/workspace-summary?*", (route) => {
    summaryRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        summary: {
          sources: {
            runs: {
              status: "ready",
              data: [
                {
                  id: "active-readiness-poll-check",
                  status: "running",
                  prompt: "Keep dashboard polling active",
                  startedAt: new Date().toISOString(),
                },
              ],
            },
            workflows: { status: "ready", data: [] },
            approvals: { status: "ready", data: [] },
          },
        },
      }),
    });
  });

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Get your workspace ready" })).toBeVisible();
  // The first summary is server-seeded. An explicit refresh supplies an
  // active run, then only the lightweight summary poll repeats at 15 seconds.
  expect(summaryRequests).toBe(0);
  await page.getByRole("button", { name: "Refresh Today" }).click();
  await expect.poll(() => summaryRequests).toBe(1);
  await expect.poll(() => summaryRequests, { timeout: 20_000 }).toBeGreaterThan(1);
  expect(readinessRequests).toBe(1);
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
  await page.getByRole("button", { name: "Refresh Today" }).click();
  await expect(
    page.getByText("Independent panel result").first(),
  ).toBeVisible();
  await page.getByText("Could not refresh workflows").click();
  await expect(
    page.getByText("Workflow source is temporarily slow."),
  ).toBeVisible();
});

test("reviewed workflow plans bind to one visible run", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/command");

  await page.getByRole("textbox", { name: "Message Asael" }).fill(
    "Summarize recent workflow evidence and produce a bounded verification report.",
  );
  await page.getByRole("button", { name: "Plan" }).click();
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Context preparation finished",
  );
  await page.getByRole("tab", { name: "Plan" }).click();
  await page.getByRole("button", { name: "Generate plan" }).click();
  await expect(
    page.getByRole("tabpanel", { name: "Plan" }),
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

test("workflow controls only offer transitions valid for the selected run", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/workflows?limit=16", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            id: "workflow-waiting-approval",
            goal: "Review the guarded release",
            status: "waiting_approval",
            currentStep: "approval_gate",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        stats: { active: 1, waitingApproval: 1 },
      }),
    });
  });

  await page.goto("/app/workflows");
  await page.getByRole("button", { name: "Load advanced controls" }).click();
  const control = page.locator("form#control-workflow");
  await expect(control).toContainText(
    "This run is already paused at an approval gate.",
  );
  await expect(control.getByLabel("Available action").locator("option"))
    .toHaveText(["Approve", "Cancel"]);
  await expect(control.getByRole("option", { name: "Pause" })).toHaveCount(0);
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
  ).toBeVisible({ timeout: 20_000 });
  await expect(reviewCard).toBeHidden({ timeout: 20_000 });

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

test("every navigation destination renders a focused page without horizontal overflow", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  const routes = [
    "/app", "/app/command", "/app/capture", "/app/projects", "/app/memory",
    "/app/agents", "/app/workflows", "/app/connectors", "/app/tools",
    "/app/approvals", "/app/results", "/app/evaluations", "/app/observability",
    "/app/security", "/app/settings",
  ];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("h1"), `${route} should expose one page title`).toHaveCount(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `${route} should fit the viewport`).toBe(false);
  }
});

test("integrations reveals Google status while slower catalogs continue loading", async ({ page }) => {
  await signIn(page);
  await page.route(/\/api\/oauth(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          {
            id: "google",
            label: "Google",
            configured: true,
            authorizeUrl: "/api/oauth/google/authorize",
            scopes: [],
          },
        ],
        grants: [
          {
            id: "google-test-grant",
            provider: "google",
            scopes: [
              "https://www.googleapis.com/auth/gmail.readonly",
              "https://www.googleapis.com/auth/calendar.events.readonly",
              "https://www.googleapis.com/auth/drive.readonly",
            ],
            status: "active",
            syncStatus: "healthy",
            syncedItems: 3,
            manageable: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        requestReadContracts: { oauthGrants: "readable_v1" },
      }),
    }),
  );
  await page.route("**/api/tools", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [], audits: {} }),
    });
  });

  await page.goto("/app/connectors");
  await expect(page.getByRole("heading", { name: "Google workspace" })).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 3_000,
  });
  await expect(
    page.getByText("Discovered tools: Loading", { exact: true }),
  ).toBeVisible();
});

test("owner can compose a skill, create an agent, and assign work from the visual arsenal", async ({ page }) => {
  test.slow();
  await signIn(page);
  const suffix = Date.now().toString(36);
  const skillName = `Daily synthesis ${suffix}`;
  const agentName = `Compass ${suffix}`;

  await page.goto("/app/agents");
  await expect(page.getByRole("heading", { name: "Your Arsenal" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Skills" })).toBeVisible();

  await page.getByRole("button", { name: "New skill" }).click();
  const skillDialog = page.getByRole("dialog", { name: "Skill" });
  await skillDialog.getByLabel("Name").fill(skillName);
  await skillDialog.getByLabel("Description").fill("Turns scattered evidence into a focused daily review.");
  await skillDialog.getByLabel("Operating instructions").fill("Summarize evidence, surface contradictions, and recommend the next three actions.");
  await skillDialog.getByRole("button", { name: "Create skill" }).click();
  await expect(page.getByRole("status")).toContainText(`${skillName} created.`);

  await page.getByRole("button", { name: "Create agent" }).click();
  const agentDialog = page.getByRole("dialog", { name: "Agent" });
  await agentDialog.getByLabel("Name").fill(agentName);
  await agentDialog.getByLabel("Role").fill("Daily chief of staff");
  await agentDialog.getByLabel("Description").fill("Keeps the owner focused on the highest-leverage work.");
  await agentDialog.getByLabel("Operating instructions").fill("Use evidence before recommendations and make uncertainty explicit.");
  await agentDialog.getByLabel(skillName).check();
  await agentDialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("status")).toContainText(`${agentName} created.`);

  const rosterAgent = page.locator(".arsenal-roster-item", { hasText: agentName });
  await expect(rosterAgent).toBeVisible();
  await rosterAgent.click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editAgentDialog = page.getByRole("dialog", { name: "Agent" });
  await editAgentDialog.getByLabel("Role").fill("Updated daily chief of staff");
  await editAgentDialog.getByLabel("Description").fill(
    "Keeps the owner focused and updates the inspector immediately.",
  );
  await editAgentDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText(`${agentName} updated.`);
  await expect(page.locator(".arsenal-inspector")).toContainText(
    "Updated daily chief of staff",
  );
  await expect(page.locator(".arsenal-inspector")).toContainText(
    "updates the inspector immediately",
  );
  await page.getByRole("link", { name: `Assign work to ${agentName}` }).click();
  await expect(page).toHaveURL(/\/app\/command\?agent=/);
  const composer = page.getByRole("region", { name: "Message Asael" });
  await expect(composer.getByText(agentName, { exact: true })).toBeVisible();

  const created = await page.evaluate(async ({ skillName, agentName }) => {
    const [skills, agents] = await Promise.all([
      fetch("/api/skills").then((response) => response.json()),
      fetch("/api/agents").then((response) => response.json()),
    ]);
    return {
      skillId: skills.skills.find(
        (item: { name?: string; manageable?: boolean }) =>
          item.name === skillName && item.manageable === true,
      )?.id,
      agentId: agents.agents.find(
        (item: { name?: string; manageable?: boolean }) =>
          item.name === agentName && item.manageable === true,
      )?.id,
    };
  }, { skillName, agentName });
  const cleanup = await page.evaluate(async ({ agentId, skillId }) => {
    const statuses: number[] = [];
    if (agentId) statuses.push((await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" })).status);
    if (skillId) statuses.push((await fetch(`/api/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" })).status);
    return statuses;
  }, created);
  expect(cleanup).toEqual([200, 200]);
});
