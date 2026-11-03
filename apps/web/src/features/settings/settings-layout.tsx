"use client";

import type { ReactNode } from "react";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { NavTabs } from "@/components/ui/tabs";
import { useWorkspace } from "@/lib/workspace/context";

export function SettingsLayout({ children }: { children: ReactNode }) {
  const { base, can, workspace } = useWorkspace();
  const root = `${base}/settings`;
  const tabs = [
    { href: root, label: "General", exact: true },
    { href: `${root}/members`, label: "Members" },
    { href: `${root}/integrations`, label: "Integrations" },
    { href: `${root}/ai`, label: "AI policy" },
    { href: `${root}/templates`, label: "Templates" },
    ...(can("audit.view") ? [{ href: `${root}/audit`, label: "Audit log" }] : []),
  ];
  return (
    <PageContainer>
      <PageHeader title="Settings" description={workspace.name} />
      <NavTabs label="Settings sections" tabs={tabs} />
      <div className="max-w-4xl">{children}</div>
    </PageContainer>
  );
}
