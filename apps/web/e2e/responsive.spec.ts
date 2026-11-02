import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("mobile navigation and layouts", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("dialog", { name: "Navigation" })
    .getByRole("link", { name: "Tasks" })
    .click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.goto("/w/acme/repositories");
  await page.getByRole("link", { name: "acme/payments-api" }).click();
  await page.getByRole("link", { name: "Code" }).click();
  await page.getByRole("button", { name: "Show files" }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  await expect(page.getByRole("region", { name: "Source of README.md" })).toBeVisible();
});
