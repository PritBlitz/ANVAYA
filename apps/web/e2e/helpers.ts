import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const VIEWER_ID = "00000000-0000-4000-8000-000000000002";

/** Sign in through the real login screen (fixtures mode). */
export async function signIn(page: Page, as: "owner" | "viewer" = "owner") {
  await page.goto("/login");
  await page
    .getByRole("button", { name: as === "owner" ? "Continue with GitHub" : /Continue as a viewer/ })
    .click();
  await expect(page).toHaveURL(/\/w\/acme$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** WCAG 2.1 A/AA scan of the visible page. */
export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(" ")}`,
  );
  expect(violations, violations.join("\n")).toEqual([]);
}
