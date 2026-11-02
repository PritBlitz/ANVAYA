"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { MailCheck } from "lucide-react";
import { useState } from "react";
import { AnvayaWordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useMe } from "@/lib/api/queries";
import { qk } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";

/** Token travels in the URL fragment (#token=…) so it never reaches server logs. */
function readToken(): string | null {
  const hash = typeof window === "undefined" ? "" : window.location.hash.replace(/^#/, "");
  const token = new URLSearchParams(hash).get("token");
  return token && token.length >= 20 ? token : null;
}

export function AcceptInvitation() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [token] = useState(readToken);
  const me = useMe();
  const accept = useMutation({
    mutationFn: () => api.workspaces.acceptInvitation(token!),
    onSuccess: async (ws) => {
      await queryClient.invalidateQueries({ queryKey: qk.workspaces });
      await queryClient.invalidateQueries({ queryKey: qk.me });
      router.replace(`/w/${ws.slug}`);
    },
  });

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="px-6 py-5">
        <AnvayaWordmark />
      </header>
      <main id="main" className="flex flex-1 items-center justify-center px-6 pb-24">
        {!token ? (
          <EmptyState
            icon={<MailCheck />}
            title="Invitation link incomplete"
            description="Open the full link you were sent. If it was cut off, ask the person who invited you for a new one."
            action={
              <Button asChild>
                <Link href="/app">Go to Anvaya</Link>
              </Button>
            }
          />
        ) : me.isPending ? (
          <Spinner label="Checking your session" className="size-6 text-fg-muted" />
        ) : accept.isError ? (
          <ErrorState error={accept.error} />
        ) : (
          <EmptyState
            icon={<MailCheck />}
            title="You've been invited to a workspace"
            description={`Signed in as ${me.data?.user.email ?? "you"}. The invitation must match this email.`}
            action={
              <Button variant="primary" loading={accept.isPending} onClick={() => accept.mutate()}>
                Accept invitation
              </Button>
            }
          />
        )}
      </main>
    </div>
  );
}
