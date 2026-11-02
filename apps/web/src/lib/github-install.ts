import { api } from "@/lib/api/runtime";

const STATE_KEY = "anvaya.github_install";
const MAX_AGE_MS = 15 * 60_000;

interface PendingInstall {
  state: string;
  slug: string;
  createdAt: number;
}

/**
 * Begin a GitHub App installation (GAP-14). The API issues the install URL together with
 * a single-use, server-held `state` bound to this user and workspace; the browser never
 * invents state. We keep the state only to return the user to the right workspace and
 * to catch obviously stale or foreign callbacks early — the server is the authority.
 */
export async function beginGitHubInstall(workspace: { id: string; slug: string }): Promise<string> {
  const { url, state } = await api.github.installUrl(workspace.id);
  const pending: PendingInstall = { state, slug: workspace.slug, createdAt: Date.now() };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(pending));
  return url;
}

/** Navigate to the install URL (relative in fixtures, github.com otherwise). */
export function goToInstallUrl(url: string, push: (href: string) => void) {
  if (url.startsWith("/")) push(url);
  else window.location.assign(url);
}

export interface CallbackParams {
  code: string | null;
  installation_id: string | null;
  setup_action: string | null;
  state: string | null;
}

export type InstallValidation =
  | {
      ok: true;
      slug: string;
      installationId: number;
      code: string;
      state: string;
      setupAction?: "install" | "update" | "request";
    }
  | { ok: false; reason: "missing_code" | "missing_installation" | "unknown_state" | "expired" };

/**
 * GitHub returns to /integrations/github/callback with code, installation_id,
 * setup_action and our state. All four are forwarded; a missing `code` means the user
 * didn't authorize, so the installation can't be linked.
 */
export function validateGitHubInstall(params: CallbackParams): InstallValidation {
  let pending: PendingInstall | null = null;
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    pending = raw ? (JSON.parse(raw) as PendingInstall) : null;
  } catch {
    pending = null;
  }
  if (!pending || !params.state || pending.state !== params.state)
    return { ok: false, reason: "unknown_state" };
  if (Date.now() - pending.createdAt > MAX_AGE_MS) return { ok: false, reason: "expired" };
  if (!params.code) return { ok: false, reason: "missing_code" };
  const installationId = Number(params.installation_id);
  if (!Number.isInteger(installationId) || installationId <= 0)
    return { ok: false, reason: "missing_installation" };
  const setup = params.setup_action;
  return {
    ok: true,
    slug: pending.slug,
    installationId,
    code: params.code,
    state: params.state,
    setupAction:
      setup === "install" || setup === "update" || setup === "request" ? setup : undefined,
  };
}

export function clearGitHubInstall() {
  sessionStorage.removeItem(STATE_KEY);
}
