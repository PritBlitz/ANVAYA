import { expect, test, type Page } from "@playwright/test";

const EMAIL = process.env.LIVE_EMAIL ?? "dev@example.test";
const WORKSPACE = process.env.LIVE_WORKSPACE ?? "dev-workspace";
const REPO = process.env.LIVE_REPO ?? "acme/demo-service";
const MODE = process.env.LIVE_MODE ?? "local";
// Defaults fit the default repository (the acme/demo-service fixture, checked with python-compile).
// Override both when LIVE_REPO points elsewhere: a task about code the repo lacks can't succeed.
const TASK =
  process.env.LIVE_TASK ??
  "Make apply_discount in billing/invoice.py raise ValueError when percent is outside 0 to 100";
const TASK_DESCRIPTION =
  process.env.LIVE_TASK_DESCRIPTION ??
  "apply_discount(total, percent) accepts any percent today. Values below 0 or above 100 should raise ValueError with a clear message; 0 and 100 stay valid.";
const STAGE = 15 * 60_000;

test.describe.configure({ mode: "serial" });

async function devLogin(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("dev@example.test").fill(EMAIL);
  await page.getByRole("button", { name: "Sign in with email" }).click();
  await expect(page).toHaveURL(/\/(app|w\/|onboarding)/);
}

/** Same-origin API call with the session and CSRF cookies the browser holds. */
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = document.cookie.match(/(?:^|; )anvaya_csrf=([^;]+)/)?.[1];
      const res = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRF-Token": decodeURIComponent(csrf) } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: res.status,
        body: res.status === 204 ? null : ((await res.json()) as Record<string, unknown>),
      };
    },
    { method, path, body },
  );
}

/**
 * Give slow providers room: switch the workspace to MODE with a longer per-request timeout and,
 * for local CPU models, a one-hour run-duration ceiling. Needs an admin of WORKSPACE.
 */
async function preparePolicy(page: Page) {
  const workspaces = await api(page, "GET", "/workspaces");
  const ws = (workspaces.body!.data as { id: string; slug: string }[]).find(
    (w) => w.slug === WORKSPACE,
  )!;
  const policy = await api(page, "PATCH", `/workspaces/${ws.id}/ai-policy`, {
    default_mode: MODE,
    limits: { request_timeout_seconds: 580 },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  // Investigation and planning alone take ~10 minutes on CPU, so the default 15-minute run
  // budget can run out mid-patch. Raise the workspace ceiling; unset budgets default to it.
  if (MODE === "local") {
    const limits = await api(page, "PATCH", `/workspaces/${ws.id}`, {
      settings: { run_budget_limits: { max_duration_seconds: 3600 } },
    });
    expect(limits.status, JSON.stringify(limits.body)).toBe(200);
  }
}

async function openRepo(page: Page) {
  await page.goto(`/w/${WORKSPACE}/repositories`);
  await page.getByRole("link", { name: REPO }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(REPO.split("/")[1]!);
}

test("sign in (and accept an invitation when given)", async ({ page }) => {
  await devLogin(page);
  if (process.env.LIVE_INVITE) {
    await page.goto(process.env.LIVE_INVITE);
    await page.getByRole("button", { name: /Accept/ }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE}`));
  }
  await page.goto(`/w/${WORKSPACE}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("repository intelligence against the real index", async ({ page }) => {
  await devLogin(page);
  await openRepo(page);
  await expect(page.getByRole("heading", { name: "Language coverage" })).toBeVisible();

  await page.getByRole("link", { name: "Code", exact: true }).click();
  await expect(page.getByRole("treeitem").first()).toBeVisible();

  await page.getByRole("link", { name: "Symbols", exact: true }).click();
  const results = page.getByRole("list", { name: "Symbol results" });
  await expect(results).toBeVisible();
  await results.getByRole("button").first().click();
  await expect(page.getByRole("region", { name: /^Source of/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Uses/ })).toBeVisible();

  await page.getByRole("link", { name: "Dependencies", exact: true }).click();
  await expect(page.getByLabel("Dependency map summary")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Repository sections" })
    .getByRole("link", { name: "Search", exact: true })
    .click();
  await page.getByLabel("Search query").fill("test");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText(/\d+ results|No matching code/)).toBeVisible();
});

test("grounded Q&A is saved to the asker's history", async ({ page }) => {
  test.setTimeout(STAGE);
  await devLogin(page);
  // Only when a mode is requested: by default Q&A uses the workspace's own policy.
  if (process.env.LIVE_MODE) await preparePolicy(page);
  await openRepo(page);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  const q = `What does this repository test? (${Date.now()})`;
  await page.getByLabel(/Ask a question/).fill(q);
  await page.getByRole("button", { name: "Ask question" }).click();
  // Scope to this session's answers: saved history may already show citation badges.
  const session = page.getByRole("list", { name: "Questions and answers" });
  // Wait for an answer or an error, then require the answer: a provider error fails at once
  // with its message instead of waiting out the whole stage.
  const outcome = session
    .getByText(/\d+ citations|No supporting evidence/)
    .or(page.getByRole("alert"));
  await expect(outcome.first()).toBeVisible({ timeout: STAGE });
  await expect(session.getByText(/\d+ citations|No supporting evidence/)).toBeVisible();
  await page.reload();
  const earlier = page.getByRole("list", { name: "Earlier questions" });
  await expect(earlier.getByText(q, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Remove “${q}” from history` }).click();
  await expect(page.getByText(q, { exact: true })).toHaveCount(0);
});

test("governed run: task → plan approval → checks → PR", async ({ page }) => {
  test.skip(!process.env.LIVE_RUN, "set LIVE_RUN=1 to open a real pull request");
  test.setTimeout(6 * STAGE);
  await devLogin(page);

  // Local models on CPU are slow: give provider calls room (the server enforces its max).
  await preparePolicy(page);

  await page.goto(`/w/${WORKSPACE}`);
  await page.getByRole("link", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New engineering task" });
  await dialog.getByLabel("Repository").selectOption({ label: REPO });
  await dialog.getByLabel("Title").fill(TASK);
  await dialog.getByLabel("Description").fill(TASK_DESCRIPTION);
  await dialog.getByRole("button", { name: "Create and investigate" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE}/runs/[\\w-]+$`));

  await expect(page.getByText("Plan approval needed").first()).toBeVisible({ timeout: STAGE });
  await page.getByRole("link", { name: "Review plan" }).click();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page
    .getByRole("dialog", { name: "Approve this plan?" })
    .getByRole("button", { name: "Approve plan" })
    .click();
  await expect(page.getByText(/Plan approved by/)).toBeVisible();

  await expect(
    page.getByText(/Ready for pull-request approval|Failed|Completed without/).first(),
  ).toBeVisible({ timeout: 3 * STAGE });
  await expect(page.getByText("Ready for pull-request approval").first()).toBeVisible();

  await page.getByRole("link", { name: "Verification" }).click();
  await expect(page.getByRole("button", { name: /^Passed/ }).first()).toBeVisible();

  await page.getByRole("link", { name: "Pull request" }).click();
  await page.getByRole("button", { name: "Approve pull request" }).click();
  await page
    .getByRole("dialog", { name: "Approve pull-request creation?" })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(page.getByRole("heading", { name: "Compose pull request" })).toBeVisible();
  await page.getByRole("button", { name: "Create pull request" }).click();
  await expect(page.getByText(/Pull request #\d+ opened/).first()).toBeVisible({
    timeout: STAGE,
  });
  const link = page.getByRole("link", { name: /Open on GitHub/ });
  await expect(link).toHaveAttribute("href", new RegExp(`github\\.com/${REPO}/pull/\\d+`));
  console.log(`PR: ${await link.getAttribute("href")}`);
});
