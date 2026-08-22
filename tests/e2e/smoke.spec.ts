import { expect, test, type Page } from "@playwright/test";

const adminEmail = "playwright-admin@example.invalid";
const adminPassword = "playwright-local-only-password";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(adminEmail);
  await page.locator("#password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
}

test("public and mobile application navigation stay usable", async ({ page }) => {
  await page.goto("/");
  const publicNavigation = page.getByRole("navigation", { name: "Public navigation" });
  await expect(publicNavigation).toBeVisible();
  await publicNavigation.getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(/\/docs$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open public navigation" }).click();
  const publicMobileMenu = page.getByRole("navigation", { name: "Public navigation" });
  await expect(publicMobileMenu).toBeVisible();
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
  await page.getByRole("button", { name: "Run task" }).click();

  const executionPanel = page.getByRole("tabpanel");
  await expect(executionPanel).toContainText("[Simulated response]");
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

test("access requests reject incomplete client and API payloads", async ({ page, request }) => {
  await page.goto("/signup");
  const submit = page.getByRole("button", { name: "Request workspace" });
  await expect(submit).toBeEnabled();

  await page.getByLabel("Name").fill("B");
  await page.getByLabel("Work email").fill("not-an-email");
  await page.getByLabel("Company").fill("O");
  await page.getByLabel("First workflow to automate").fill("too short");
  await submit.click();
  await expect(
    page.locator('[data-testid="access-request-form"] [role="alert"]'),
  ).toContainText("Review the highlighted fields");
  await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Work email")).toHaveAttribute("aria-invalid", "true");

  const response = await request.post("/api/onboarding/request-access", {
    data: {
      name: "B",
      email: "not-an-email",
      company: "O",
      role: "engineering",
      timeline: "30_days",
      useCase: "too short",
    },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ error: "Invalid access request" });
});

test("valid access requests are persisted before success is shown", async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const requestedName = `Ada Operator ${suffix}`;
  const requestedEmail = `ada-${suffix}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Name").fill(requestedName);
  await page.getByLabel("Work email").fill(requestedEmail);
  await page.getByLabel("Company").fill("Example Team");
  await page.getByLabel("First workflow to automate").fill(
    "Review incidents and prepare a remediation plan with linked evidence.",
  );
  await page.getByRole("button", { name: "Request workspace" }).click();

  await expect(page.getByRole("status")).toContainText("pending review");
  await expect(page.getByRole("status")).toContainText("complete request was stored");

  await signIn(page);
  await page.goto("/app/approvals");
  const accessSection = page.getByRole("region", { name: "Workspace access" });
  await expect(
    accessSection.getByRole("heading", { name: requestedName }),
  ).toBeVisible();
  await accessSection
    .getByLabel(`Review note for ${requestedName}`)
    .fill("Team owner verified.");
  await accessSection.getByRole("button", { name: "Approve request" }).click();
  await expect(page.getByRole("status")).toContainText(
    `Approved ${requestedName}`,
  );
  await expect(
    accessSection.getByText(
      "Access is approved. Finish creating the workspace identity; this request stays here until provisioning succeeds.",
    ),
  ).toBeVisible();
  await expect(
    accessSection.getByRole("button", { name: "Resume provisioning" }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: `Provision ${requestedName}` })
    .click();
  await expect(page).toHaveURL(/\/app\/settings#create-user$/);
  const createUserForm = page.locator("form").filter({ hasText: "Create workspace user" });
  await expect(createUserForm.getByLabel("Name")).toHaveValue(requestedName);
  await expect(createUserForm.getByLabel("Email")).toHaveValue(requestedEmail);
  await createUserForm.getByLabel("Workspace role").selectOption("viewer");
  await createUserForm.getByLabel("Initial password (optional)").fill(
    "playwright-new-user-password",
  );
  await createUserForm.getByRole("button", { name: "Run action" }).click();
  await expect(page.getByText("Action completed.")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email address").fill(requestedEmail);
  await page.locator("#password").fill("playwright-new-user-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
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
