import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

test.describe("authentication", () => {
  test("unauthenticated users are sent to sign-in and returned afterwards", async ({ page }) => {
    await page.goto("/w/acme/runs");
    await expect(page).toHaveURL(/\/login\?next=%2Fw%2Facme%2Fruns/);
    await expectAccessible(page);
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await expect(page).toHaveURL(/\/w\/acme\/runs$/);
    await expect(page.getByRole("heading", { name: "Runs", level: 1 })).toBeVisible();
  });

  test("rejects open redirects after sign-in", async ({ page }) => {
    await page.goto("/login?next=//evil.example");
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await expect(page).toHaveURL(/\/w\/acme$/);
  });
});

test("task → plan approval → verification → review → pull request", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Needs your decision" })).toBeVisible();
  await expectAccessible(page);

  // Create a task and start the investigation.
  await page.getByRole("link", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New engineering task" });
  await dialog.getByRole("button", { name: "Create and investigate" }).click();
  await expect(dialog.getByText("Choose a repository")).toBeVisible();
  await dialog.getByLabel("Repository").selectOption({ label: "acme/payments-api" });
  await dialog.getByLabel("Title").fill("Refresh token race clears valid sessions");
  await dialog
    .getByLabel("Description")
    .fill("Two concurrent refreshes reuse a single-use token and sign the user out.");
  await dialog.getByRole("button", { name: "Create and investigate" }).click();

  // Run workspace: live progress until the plan gate.
  await expect(page).toHaveURL(/\/w\/acme\/runs\/[\w-]+$/);
  await expect(page.getByText("Plan approval needed").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: "Review plan" }).click();
  await expect(page.getByText("Prevent concurrent refresh attempts")).toBeVisible();
  await expect(page.getByRole("link", { name: /src\/auth\/refresh\.ts:16/ })).toBeVisible();
  await expectAccessible(page);

  // Rejecting needs a reason; then approve instead.
  await page.getByRole("button", { name: "Reject" }).click();
  const reject = page.getByRole("dialog", { name: "Reject this plan?" });
  await reject.getByRole("button", { name: "Reject plan" }).click();
  await expect(reject.getByText("Add a reason for rejecting")).toBeVisible();
  await reject.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Approve plan" }).click();
  await page
    .getByRole("dialog", { name: "Approve this plan?" })
    .getByRole("button", { name: "Approve plan" })
    .click();
  await expect(page.getByText(/Plan approved by/)).toBeVisible();

  // Implementation, verification and review complete; PR gate opens.
  await expect(page.getByText("Ready for pull-request approval")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("link", { name: "Changes" }).click();
  await expect(page.getByText("Within approved scope")).toBeVisible();
  await expect(page.getByRole("table", { name: "Diff of src/auth/refresh.ts" })).toBeVisible();

  await page.getByRole("link", { name: "Verification" }).click();
  await expect(page.getByRole("button", { name: /Passed npm test node\.test/ })).toBeVisible();
  await expect(page.getByText("Models cannot set pass/fail")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: "Review", exact: true }).click();
  await expect(page.getByText("Module-level in-flight promise")).toBeVisible();
  await page.getByRole("button", { name: "AI review 1" }).click();
  await expect(page.getByText("Unused import")).toBeHidden();

  await page.getByRole("link", { name: "Pull request" }).click();
  await expect(page.getByText("Deterministic checks passed")).toBeVisible();
  await page.getByRole("button", { name: "Approve pull request" }).click();
  await page
    .getByRole("dialog", { name: "Approve pull-request creation?" })
    .getByRole("button", { name: "Approve" })
    .click();

  await expect(page.getByRole("heading", { name: "Compose pull request" })).toBeVisible();
  // Short summary: the server appends the verification/review evidence section itself.
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue(/## Summary/);
  await expect(page.getByRole("textbox", { name: "Description" })).not.toHaveValue(
    /## Verification/,
  );
  await page.getByRole("button", { name: "Create pull request" }).click();
  await expect(page.getByText(/Pull request #\d+ opened/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Open on GitHub/ })).toHaveAttribute(
    "href",
    /github\.com\/acme\/payments-api\/pull\/\d+/,
  );
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
});

test("blocking findings prevent PR approval until resolved", async ({ page }) => {
  await signIn(page);
  await page
    .getByRole("link", { name: /Send idempotency keys/ })
    .first()
    .click();
  await page.getByRole("link", { name: "Pull request" }).click();
  await expect(page.getByText(/high\/critical finding/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve pull request" })).toBeDisabled();
  await page.getByRole("link", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Mark fixed" }).first().click();
  await expect(page.getByText("No blocking findings")).toBeVisible();
  await page.getByRole("link", { name: "Pull request" }).click();
  await expect(page.getByRole("button", { name: "Approve pull request" })).toBeEnabled();
});

test("search and grounded Q&A open cited lines", async ({ page }) => {
  await signIn(page);
  await page.goto("/w/acme/repositories");
  await page.getByRole("link", { name: "acme/payments-api" }).click();
  await expect(page.getByRole("heading", { name: "Language coverage" })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByLabel("Search query").fill("refresh token expiry");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/q=refresh\+token\+expiry/);
  await expect(page.getByText(/\d+ results/)).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page.getByRole("button", { name: "How are webhook signatures verified?" }).click();
  await expect(page.getByText(/\d+ citations/)).toBeVisible();
  await page.getByRole("link", { name: "src/payments/webhooks.ts" }).first().click();
  await expect(page).toHaveURL(/code\?path=src%2Fpayments%2Fwebhooks\.ts&lines=/);
  await expect(
    page.getByRole("region", { name: /^Source of/ }).locator('[aria-current="location"]'),
  ).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "webhooks.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Unanswerable questions get no invented citations.
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page.getByLabel(/Ask a question/).fill("What is the capital of France?");
  await page.getByRole("button", { name: "Ask question" }).click();
  await expect(page.getByText("No supporting evidence")).toBeVisible();
});

test("the Content-Security-Policy blocks nothing the app needs", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  const res = await page.goto("/");
  expect(res?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await signIn(page);
  for (const path of [
    "/w/acme/repositories",
    "/w/acme/runs",
    "/w/acme/settings",
    "/w/acme/usage",
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  }
  await page.goto("/w/acme/repositories");
  await page.getByRole("link", { name: "acme/payments-api" }).click();
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  await expect(page.getByRole("region", { name: /^Source of/ })).toBeVisible();
  expect(violations).toEqual([]);
});

test("Q&A cites knowledge notes and keeps a private history", async ({ page }) => {
  await signIn(page);
  await page.goto("/w/acme/repositories");
  await page.getByRole("link", { name: "acme/payments-api" }).click();
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page.getByRole("button", { name: "What happens when a charge request fails?" }).click();
  await expect(page.getByText(/\d+ from knowledge notes/)).toBeVisible();
  await expectAccessible(page);

  // The answer survives a reload as a saved history entry.
  await page.reload();
  const earlier = page.getByRole("list", { name: "Earlier questions" });
  await expect(earlier.getByText("What happens when a charge request fails?")).toBeVisible();

  // Knowledge citations open the note.
  await earlier
    .getByRole("link", { name: /ADR-006/ })
    .first()
    .click();
  await expect(page).toHaveURL(/knowledge\?doc=/);
  await expect(page.getByRole("dialog")).toContainText("idempotency key");
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page
    .getByRole("button", {
      name: /Remove “What happens when a charge request fails\?” from history/,
    })
    .click();
  await expect(page.getByText("Removed from your history")).toBeVisible();
  await expect(page.getByRole("list", { name: "Earlier questions" })).toHaveCount(0);
});

test("symbol explorer and dependency map link to source", async ({ page }) => {
  await signIn(page);
  await page.goto("/w/acme/repositories");
  await page.getByRole("link", { name: "acme/payments-api" }).click();

  await page.getByRole("link", { name: "Symbols", exact: true }).click();
  await page.getByLabel("Symbol name").fill("decode");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/q=decode/);
  await page.getByRole("list", { name: "Symbol results" }).getByRole("button").first().click();
  await expect(page.getByRole("heading", { level: 2, name: "decodeJwt" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Source of decodeJwt" })).toBeVisible();
  // Used by refreshSession / getAccessToken in src/auth/refresh.ts.
  await expect(page.getByRole("button", { name: /Called by|Imported by/ }).first()).toBeVisible();
  await expectAccessible(page);

  // Kind filter round-trips through the URL.
  await page.getByRole("button", { name: "class", exact: true }).click();
  await expect(page).toHaveURL(/kind=class/);

  await page.getByRole("link", { name: "Dependencies", exact: true }).click();
  await expect(page.getByLabel("Dependency map summary")).toBeVisible();
  await page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: /src\/auth\/token\.ts/ })
    .click();
  await expect(page.getByRole("heading", { name: "src/auth/token.ts" })).toBeVisible();
  await expect(page.getByRole("list", { name: "External packages" })).toContainText("express");
  await expectAccessible(page);
  await page
    .getByRole("link", { name: /import in src\/auth\/refresh\.ts/ })
    .first()
    .click();
  await expect(page).toHaveURL(/code\?path=src%2Fauth%2Frefresh\.ts&lines=/);
});

test("onboarding: new workspace, GitHub install, select repositories, index", async ({ page }) => {
  await signIn(page);
  await page.goto("/onboarding");
  await page.getByLabel("Workspace name").fill("Platform Team");
  await expect(page.getByLabel("Workspace URL")).toHaveValue("platform-team");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page).toHaveURL(/\/w\/platform-team\/repositories\/connect\?onboarding=1/);
  await expect(page.getByText("Requested permissions")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: /Install on GitHub/ }).click();

  await expect(page.getByText("acme-labsConnected")).toBeVisible();
  await page.getByLabel("acme-labs/checkout-service").check();
  await page.getByRole("button", { name: "Connect and start indexing" }).click();
  await expect(page.getByRole("heading", { name: /checkout-service/ })).toBeVisible();
  await expect(page.getByText("Indexed", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
});

test("GitHub callback with a forged state is rejected", async ({ page }) => {
  await signIn(page);
  await page.goto("/integrations/github/callback?installation_id=1&state=forged");
  await expect(page.getByRole("heading", { name: "Installation not verified" })).toBeVisible();
});

test("viewers can read but not decide", async ({ page }) => {
  await signIn(page, "viewer");
  await page.getByRole("link", { name: /Plan approval needed.*Concurrent refresh/ }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByText("Waiting for approval")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve plan" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New task" })).toHaveCount(0);
});

test("command palette and theme", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("usage");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/w\/acme\/usage$/);
  await expect(page.getByRole("button", { name: /tokens, \d+ requests/ }).first()).toBeVisible();

  await page.keyboard.press("Control+k");
  await palette.getByRole("combobox").fill("theme");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectAccessible(page);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("tasks from a pull request and from a failing check show imported context", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New engineering task" });
  await dialog.getByLabel("Repository").selectOption({ label: "acme/payments-api" });
  await dialog.getByLabel("Source").selectOption({ label: "GitHub pull request" });
  await dialog.getByLabel("Pull request number").fill("87");
  await dialog.getByLabel("Include review comments").check();
  await dialog.getByLabel("Start investigation now").uncheck();
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(page).toHaveURL(/\/w\/acme\/tasks\/[\w-]+$/);
  await expect(page.getByText("Pull request #87").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Changed files" })).toContainText(
    "src/auth/token-refresher.ts",
  );
  await expect(page.getByRole("region", { name: "Review comments" })).toBeVisible();
  await expectAccessible(page);

  await page.goto("/w/acme/tasks?new=1");
  const second = page.getByRole("dialog", { name: "New engineering task" });
  await second.getByLabel("Repository").selectOption({ label: "acme/payments-api" });
  await second.getByLabel("Source").selectOption({ label: "Failing CI check" });
  await second.getByRole("radio", { name: /test \(node 22\)/ }).check();
  await expectAccessible(page);
  await second.getByLabel("Start investigation now").uncheck();
  await second.getByRole("button", { name: "Create task" }).click();
  await expect(
    page.getByRole("heading", { name: "Fix failing check: test (node 22)" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Annotations" })).toContainText(
    "src/auth/token-refresher.ts:42",
  );
});

test("admins set run quotas and see usage; starts beyond the limit explain why", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/w/acme/settings/ai");
  const quotas = page.getByRole("form", { name: "Quotas and concurrency" });
  await expect(quotas).toBeVisible();
  await quotas.getByLabel("Concurrent active runs", { exact: true }).fill("1");
  await quotas.getByRole("button", { name: "Save quotas" }).click();
  await expect(page.getByText("Quotas updated")).toBeVisible();
  await expect(quotas.getByRole("meter", { name: "Concurrent active runs used" })).toBeVisible();
  await expect(quotas).toContainText("limit reached");
  await expectAccessible(page);

  // The seeded workspace already has active runs, so a new one is refused with a reason.
  await page.goto("/w/acme/tasks?new=1");
  const dialog = page.getByRole("dialog", { name: "New engineering task" });
  await dialog.getByLabel("Repository").selectOption({ label: "acme/payments-api" });
  await dialog.getByLabel("Title").fill("Quota-limited task");
  await dialog
    .getByLabel("Description")
    .fill("This run should be refused by the concurrency limit.");
  await dialog.getByRole("button", { name: "Create and investigate" }).click();
  await expect(page.getByText("Task created, but the run didn't start")).toBeVisible();
  await expect(page.getByText(/This workspace allows 1 active run at a time/)).toBeVisible();
  await expect(page).toHaveURL(/\/w\/acme\/tasks\/[\w-]+$/);
});
