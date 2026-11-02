"use client";

import "@/lib/zod-config";
import { QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/overlays";
import { createQueryClient } from "@/lib/api/query-client";
import { ThemeProvider, useTheme } from "@/lib/theme";

const PUBLIC_PATHS = ["/login"];

function ThemedToaster() {
  const { resolved } = useTheme();
  return (
    <Toaster
      theme={resolved}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "!rounded-lg !border !border-border !bg-surface-raised !text-fg !shadow-lg !font-sans",
          description: "!text-fg-muted",
          actionButton: "!bg-primary !text-primary-fg",
        },
      }}
    />
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();

  const [queryClient] = useState(() =>
    createQueryClient(() => {
      // Any 401 sends the user to sign-in, preserving where they were.
      const current = `${window.location.pathname}${window.location.search}`;
      if (PUBLIC_PATHS.some((p) => current.startsWith(p))) return;
      router.replace(`/login?next=${encodeURIComponent(current)}`);
    }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          {children}
          <ThemedToaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
