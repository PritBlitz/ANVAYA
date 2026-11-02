/**
 * Captures real product screenshots for the public homepage, in light and dark themes.
 *
 *   npm run dev            # in another terminal (fixtures mode)
 *   npm run screenshots    # BASE_URL=http://localhost:3000 by default
 *
 * Screens are produced by driving the actual UI against the development fixtures, so
 * the homepage always shows the product as it really is. Re-run after UI changes.
 */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = fileURLToPath(new URL("../src/features/marketing/screenshots/", import.meta.url));

// Hide development-only chrome: Next dev overlay, toasts, and the fixtures notice.
const CLEAN_CSS = `nextjs-portal, [data-sonner-toaster], [data-dev-notice] { display: none !important; }
*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }`;

async function shot(page, name, theme) {
  await page.addStyleTag({ content: CLEAN_CSS });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}${name}-${theme}.png` });
  console.log(`  ✓ ${name}-${theme}.png`);
}

async function capture(theme) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.waitForURL(/\/w\/acme$/);
  await page.getByRole("heading", { name: "Needs your decision" }).waitFor();
  await page
    .getByRole("link", { name: /Concurrent refresh requests/ })
    .first()
    .waitFor();
  await shot(page, "overview", theme);

  // Plan approval gate
  await page.getByRole("link", { name: /Plan approval needed.*Concurrent refresh/ }).click();
  await page.getByText("Prevent concurrent refresh attempts").first().waitFor();
  await shot(page, "plan", theme);

  // Run awaiting PR approval: changes, verification, review
  await page.goto(`${BASE}/w/acme/runs?filter=awaiting`);
  await page.getByRole("link", { name: /Send idempotency keys/ }).click();
  await page.getByRole("link", { name: "Changes", exact: true }).click();
  await page.getByRole("table", { name: /Diff of src\/payments\/charge\.ts/ }).waitFor();
  await shot(page, "changes", theme);

  await page.getByRole("link", { name: "Verification", exact: true }).click();
  await page.getByRole("button", { name: /Passed npm test/ }).waitFor();
  await shot(page, "verification", theme);

  await page.getByRole("link", { name: "Review", exact: true }).click();
  await page.getByText("Idempotency key forwarded without format validation").waitFor();
  await shot(page, "review", theme);

  // Grounded Q&A with an expanded citation
  await page.goto(`${BASE}/w/acme/repositories`);
  await page.getByRole("link", { name: "acme/payments-api" }).click();
  await page.getByRole("heading", { name: "Language coverage" }).waitFor();
  await shot(page, "index", theme);

  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page.getByRole("button", { name: "Where is refresh token expiry handled?" }).click();
  await page.getByText(/\d+ citations/).waitFor();
  await page
    .getByRole("region", { name: /Cited lines/ })
    .first()
    .waitFor();
  await shot(page, "ask", theme);

  await browser.close();
}

await mkdir(OUT, { recursive: true });
for (const theme of ["light", "dark"]) {
  console.log(`Capturing ${theme} theme…`);
  await capture(theme);
}
