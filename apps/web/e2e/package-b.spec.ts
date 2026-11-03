import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

/** WCAG 2.1 A/AA scan limited to one region (used where the surrounding page is out of scope). */
async function expectRegionAccessible(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

test("a template prefills the task, and its run shows heuristic impact and test selection", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New engineering task" });
  await dialog.getByLabel("Repository").selectOption({ label: "acme/payments-api" });
  await dialog.getByLabel("Title").fill("refresh token race clears sessions");
  await dialog.getByLabel("Template").selectOption({ label: "Bug fix" });
  await expect(dialog.getByLabel("Title")).toHaveValue("Fix: refresh token race clears sessions");
  await expect(dialog.getByLabel("Description")).toHaveValue(/## Observed behaviour/);
  await expect(dialog.getByText(/at most 5 changed files/)).toBeVisible();
  await dialog
    .getByLabel("Description")
    .fill("Two concurrent refreshes reuse a single-use token and sign the user out.");
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Create and investigate" }).click();

  await expect(page).toHaveURL(/\/w\/acme\/runs\/[\w-]+$/);
  await expect(page.getByText("Plan approval needed").first()).toBeVisible({ timeout: 20_000 });

  // Before a patch exists, impact is predicted from the plan's files.
  await page.getByRole("link", { name: "Changes" }).click();
  const before = page.getByTestId("impact-panel").filter({ visible: true });
  await expect(before).toBeVisible();
  await expect(before.getByText("Heuristic", { exact: true })).toBeVisible();
  await expect(before.getByText(/not a verification result/)).toBeVisible();
  await expect(before.getByText(/files in the plan/)).toBeVisible();
  await expect(
    before.getByRole("link", { name: "test/auth/refresh.test.ts", exact: true }),
  ).toBeVisible();

  // Approve, then the patch drives the prediction.
  await page.getByRole("link", { name: "Review plan" }).click();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page
    .getByRole("dialog", { name: "Approve this plan?" })
    .getByRole("button", { name: "Approve plan" })
    .click();
  await expect(page.getByText("Ready for pull-request approval")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("link", { name: "Changes" }).click();
  const after = page.getByTestId("impact-panel").filter({ visible: true });
  await expect(after.getByText(/the applied patch/)).toBeVisible();
  // A test file changed by the patch ranks first ("the test file itself is changed").
  await expect(after.getByText("The test file itself is changed.").first()).toBeVisible();
  // An importing test is selected with its evidence path linked to the import line.
  const importer = after
    .getByTestId("selected-test")
    .filter({ hasText: "Imports changed file" })
    .first();
  await expect(
    importer.getByRole("link", {
      name: /test\/auth\/refresh\.test\.ts imports src\/auth\/refresh\.ts \(line \d+\)/,
    }),
  ).toBeVisible();
  await expectRegionAccessible(page, '[data-testid="impact-panel"]');

  await page.getByRole("link", { name: "Verification" }).click();
  await expect(page.getByTestId("impact-panel").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Models cannot set pass/fail")).toBeVisible();
});

test("a migration plan is plan-only and ends at approval", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New engineering task" });
  await dialog.getByLabel("Repository").selectOption({ label: "acme/payments-api" });
  await dialog.getByLabel("Template").selectOption({ label: "Migration plan" });
  await expect(dialog.getByText(/Plan only/)).toBeVisible();
  await dialog.getByLabel("Title").fill("Migration plan: move token storage");
  await dialog.getByLabel("Description").fill("Move token storage into the session service.");
  await dialog.getByRole("button", { name: "Create and investigate" }).click();
  await expect(page.getByText("Plan approval needed").first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: "Review plan" }).click();
  await expect(page.getByTestId("migration-plan")).toBeVisible();
  await expect(page.getByText(/Rollback:/).first()).toBeVisible();
  await expect(page.getByTestId("plan-only-note")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page
    .getByRole("dialog", { name: "Approve this plan?" })
    .getByRole("button", { name: "Approve plan" })
    .click();
  await expect(page.getByText(/Plan approved by/)).toBeVisible();
});

test("admins manage workspace templates; viewers see them read-only", async ({ page }) => {
  await signIn(page);
  await page.goto("/w/acme/settings/templates");
  await expect(page.getByText("Built-in templates", { exact: true })).toBeVisible();
  await expect(page.getByTestId("template-migration_plan")).toContainText("Plan only");
  await page.getByRole("button", { name: "New template" }).click();
  const form = page.getByRole("form", { name: "New template" });
  await form.getByLabel("Name").fill("Security fix");
  await form.getByLabel("Key").fill("security_fix");
  await form.getByLabel("Planning guidance").fill("Do not change public interfaces.");
  await form.getByRole("button", { name: "Create template" }).click();
  const card = page.getByTestId("template-security_fix");
  await expect(card).toContainText("Workspace · v1");
  await expect(card).toContainText("Do not change public interfaces.");
  await expectAccessible(page);

  await card.getByRole("button", { name: "Archive" }).click();
  await page
    .getByRole("dialog", { name: /Archive "Security fix"/ })
    .getByRole("button", { name: "Archive template" })
    .click();
  await expect(page.getByTestId("template-security_fix")).toContainText("Archived");
});

test("viewers see templates read-only", async ({ page }) => {
  await signIn(page, "viewer");
  await page.goto("/w/acme/settings/templates");
  await expect(
    page.getByText("Only workspace admins can create or archive templates."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New template" })).toHaveCount(0);
});

test("workspace search shows per-result repository provenance", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Search", exact: true }).first().click();
  await expect(page).toHaveURL(/\/w\/acme\/search$/);
  await page.getByLabel("Search all repositories").fill("token refresh");
  await page.getByRole("button", { name: "Search", exact: true }).last().click();
  const result = page.getByTestId("workspace-result").first();
  await expect(result).toBeVisible();
  await expect(result.getByText(/^acme\//)).toBeVisible();
  await expectAccessible(page);
});
