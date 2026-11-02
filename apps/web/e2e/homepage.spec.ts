import { expect, test } from "@playwright/test";
import { expectAccessible } from "./helpers";

test.describe("public homepage", () => {
  test("is public, accessible, and leads to sign-in", async ({ browser }) => {
    // Scan the settled page: looping decorative fades would otherwise be sampled
    // mid-transition (transient states aren't a WCAG contrast failure).
    const context = await browser.newContext({
      reducedMotion: "reduce",
      ...test.info().project.use,
    });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("heading", { level: 1, name: /evidence-backed engineering change/ }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: /Six steps from intent/ })).toBeAttached();

    // Scroll everything into view so reveal animations settle before scanning.
    const height = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < height; y += 600) await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    await expectAccessible(page);

    await page.getByRole("link", { name: "Get started" }).first().click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await expect(page).toHaveURL(/\/w\/acme$/);
    await context.close();
  });

  test("how it works follows scroll and product tour switches screenshots", async ({ page }) => {
    test.skip(
      test.info().project.name === "mobile",
      "Sticky stage and header nav are desktop-only by design",
    );
    await page.goto("/");
    await page.getByRole("link", { name: "How it works" }).first().click();
    await expect(page).toHaveURL(/#how-it-works$/);
    const step = page.locator("#how-it-works li[data-index='3']");
    await step.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 150));
    await expect(page.getByText("Step 4 of 6 · Plan")).toBeVisible();

    await page.getByRole("tab", { name: "Grounded Q&A" }).click();
    await expect(
      page.getByRole("img", { name: /Q&A showing an AI answer/ }).first(),
    ).toBeAttached();
  });

  test("shows all content with reduced motion", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");
    await page.locator("#security").scrollIntoViewIfNeeded();
    await expect(page.getByRole("heading", { name: /Repository code is untrusted/ })).toBeVisible();
    const hidden = await page.evaluate(
      () =>
        [...document.querySelectorAll("[data-reveal]")].filter(
          (el) => getComputedStyle(el).opacity === "0",
        ).length,
    );
    expect(hidden).toBe(0);
    await context.close();
  });

  test("signed-in users can still open the app from /app", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await expect(page).toHaveURL(/\/w\/acme$/);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/w\/acme$/);
  });
});
