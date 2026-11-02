"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, FileSearch, GitPullRequest, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { AnvayaWordmark, GitHubMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { api, API_BASE_PATH, API_MODE, getFixtureControls } from "@/lib/api/runtime";
import { describeError } from "@/lib/api/errors";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { safeNextPath } from "@/lib/utils/url";

const TRAIL = [
  {
    icon: <FileSearch />,
    label: "Evidence retrieved",
    detail: "src/auth/refresh.ts · L16–31 @ 9f3c2a1",
  },
  { icon: <CheckCircle2 />, label: "Plan approved", detail: "by Ira Shah · 2 files in scope" },
  { icon: <ShieldCheck />, label: "Checks executed", detail: "npm test · exit 0 · 8.4s" },
  { icon: <GitPullRequest />, label: "Pull request opened", detail: "#482 after human approval" },
];

/** Codes the API appends as `/login?error=` after a failed GitHub sign-in. */
const SIGN_IN_ERRORS: Record<string, string> = {
  github_email_permission:
    "The GitHub App is missing the “Email addresses” permission, so Anvaya can’t read your verified email. Ask an organization admin to grant it, then try again.",
  email_in_use:
    "That email address is already linked to a different Anvaya account. Sign in with that account instead.",
  oauth_failed: "GitHub sign-in didn’t complete. Please try again.",
};

function signInErrorMessage(code: string): string {
  return SIGN_IN_ERRORS[code] ?? "Sign-in didn’t complete. Please try again.";
}

export function LoginScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const next = safeNextPath(params.get("next"), "/app");
  const [pending, setPending] = useState<string | null>(null);
  const error = params.get("error");

  // Which sign-in methods the backend enables (public endpoint).
  const providers = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: api.auth.providers,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const githubEnabled = API_MODE === "fixtures" || providers.data?.github !== false;
  const devEnabled = !!providers.data?.dev;
  const [devEmail, setDevEmail] = useState("");
  const [devError, setDevError] = useState<string | null>(null);
  const devLogin = useMutation({
    mutationFn: () => api.auth.devLogin(devEmail.trim()),
    onSuccess: () => {
      queryClient.clear();
      router.replace(next);
    },
    onError: (e) => setDevError(describeError(e).description),
  });

  // GitHub OAuth (GAP-01): the API sets the HttpOnly session cookie and redirects back
  // to return_to (same-origin paths only). A plain link (not JS) keeps it robust.
  const oauthHref = `${API_BASE_PATH}/auth/github/login?return_to=${encodeURIComponent(next)}`;

  async function fixtureSignIn(userId?: string, key = "github") {
    setPending(key);
    const controls = await getFixtureControls();
    controls?.signIn(userId);
    queryClient.clear();
    router.replace(next);
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-[#2a0710] p-12 text-[#f5ebd0] lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 [background-image:linear-gradient(#f5ebd0_1px,transparent_1px),linear-gradient(90deg,#f5ebd0_1px,transparent_1px)] [background-size:32px_32px] opacity-[0.07]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 -right-40 size-[520px] rounded-full bg-[#7f011f] opacity-60 blur-3xl"
        />
        <div className="relative flex items-center gap-2">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
            <path
              d="M9 23.5 16 8.5l7 15M11.6 18h8.8"
              stroke="#F5EBD0"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <circle cx="16" cy="8.5" r="2.4" fill="#F5EBD0" />
            <circle cx="9" cy="23.5" r="2.4" fill="#F5EBD0" />
            <circle cx="23" cy="23.5" r="2.4" fill="#F5EBD0" />
          </svg>
          <span className="font-display text-2xl">Anvaya</span>
        </div>
        <div className="relative max-w-lg">
          <p className="font-display text-[3.25rem] leading-[1.05] tracking-tight">
            From codebase understanding to <em className="text-[#eadbb4]">evidence-backed</em>{" "}
            engineering change.
          </p>
          <ol className="mt-10 space-y-0" aria-label="Example evidence trail">
            {TRAIL.map((step, i) => (
              <li key={step.label} className="relative flex gap-4 pb-5 last:pb-0">
                {i < TRAIL.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute top-7 left-[13px] h-[calc(100%-20px)] w-px bg-[#f5ebd0]/20"
                  />
                )}
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[#f5ebd0]/25 bg-[#f5ebd0]/5 [&_svg]:size-3.5">
                  {step.icon}
                </span>
                <span>
                  <span className="block text-sm font-medium">{step.label}</span>
                  <span className="block font-mono text-xs text-[#f5ebd0]/60">{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="relative text-xs text-[#f5ebd0]/50">
          AI proposes. You approve. Deterministic checks decide.
        </p>
      </section>

      <section className="flex items-center justify-center bg-bg px-6 py-16">
        <div className="w-full max-w-sm">
          <AnvayaWordmark className="mb-10 lg:hidden" />
          <h1 className="text-xl font-semibold tracking-tight text-fg">Sign in to Anvaya</h1>
          <p className="mt-1.5 text-sm text-fg-muted">
            Use your GitHub account. Repository access is granted separately through the GitHub App.
          </p>

          {error && (
            <p
              role="alert"
              className="mt-5 rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              {signInErrorMessage(error)}
            </p>
          )}

          <div className="mt-8 flex flex-col gap-2.5">
            {!githubEnabled ? null : API_MODE === "fixtures" ? (
              <Button
                variant="primary"
                size="lg"
                onClick={() => fixtureSignIn()}
                loading={pending === "github"}
                disabled={!!pending}
              >
                {pending !== "github" && <GitHubMark />}
                Continue with GitHub
              </Button>
            ) : (
              <Button asChild variant="primary" size="lg">
                <a href={oauthHref} onClick={() => setPending("github")} aria-disabled={!!pending}>
                  <GitHubMark />
                  Continue with GitHub
                </a>
              </Button>
            )}
            {API_MODE === "fixtures" && (
              <Button
                variant="secondary"
                size="lg"
                onClick={() => fixtureSignIn("00000000-0000-4000-8000-000000000002", "viewer")}
                loading={pending === "viewer"}
                disabled={!!pending}
              >
                Continue as a viewer (read-only)
              </Button>
            )}
          </div>

          {devEnabled && (
            <form
              className="mt-6 flex flex-col gap-2 rounded-lg border border-dashed border-border-strong p-4"
              onSubmit={(e) => {
                e.preventDefault();
                setDevError(null);
                devLogin.mutate();
              }}
            >
              <Field
                label="Developer sign-in"
                hint="Enabled by the API for local development only."
                error={devError ?? undefined}
              >
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="dev@example.test"
                  value={devEmail}
                  onChange={(e) => setDevEmail(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="secondary"
                loading={devLogin.isPending}
                disabled={!devEmail.includes("@")}
              >
                Sign in with email
              </Button>
            </form>
          )}

          {API_MODE === "fixtures" && (
            <p className="mt-6 rounded-md border border-dashed border-highlight-border bg-highlight px-3 py-2 text-xs text-accent-fg">
              Development fixtures are active. Signing in creates a local demo session — nothing
              leaves your browser.
            </p>
          )}
          <p className="mt-10 text-xs leading-relaxed text-fg-subtle">
            Anvaya never merges or deploys on its own. Local inference is the default; cloud models
            run only when your workspace opts in.
          </p>
        </div>
      </section>
    </div>
  );
}
