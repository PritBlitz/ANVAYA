import { API_MODE } from "@/lib/api/runtime";
import { createRequestId } from "@/lib/api/client";

const STATE_KEY = "anvaya.github_install";
const MAX_AGE_MS = 15 * 60_000;

export const FIXTURE_INSTALLATION_ID = 99_001;

interface PendingInstall {
  state: string;
  slug: string;
  createdAt: number;
}

/**
 * Begin a GitHub App installation. A random `state` is stored in sessionStorage and
 * checked on return so a forged callback URL cannot attach an installation to the
 * user's workspace (GAP-14).
 */
export function beginGitHubInstall(workspaceSlug: string): string {
  const state = createRequestId();
  const pending: PendingInstall = { state, slug: workspaceSlug, createdAt: Date.now() };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(pending));
  if (API_MODE === "fixtures") {
    return `/integrations/github/callback?installation_id=${FIXTURE_INSTALLATION_ID}&setup_action=install&state=${state}`;
  }
  const appSlug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? "anvaya";
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export type InstallValidation =
  { ok: true; slug: string } | { ok: false; reason: "missing" | "mismatch" | "expired" };

export function validateGitHubInstall(stateParam: string | null): InstallValidation {
  let pending: PendingInstall | null = null;
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    pending = raw ? (JSON.parse(raw) as PendingInstall) : null;
  } catch {
    pending = null;
  }
  if (!pending || !stateParam) return { ok: false, reason: "missing" };
  if (pending.state !== stateParam) return { ok: false, reason: "mismatch" };
  if (Date.now() - pending.createdAt > MAX_AGE_MS) return { ok: false, reason: "expired" };
  return { ok: true, slug: pending.slug };
}

export function clearGitHubInstall() {
  sessionStorage.removeItem(STATE_KEY);
}
