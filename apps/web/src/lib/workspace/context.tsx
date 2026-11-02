"use client";

import { createContext, useContext, type ReactNode } from "react";
import { apiClient } from "@/lib/api/runtime";
import type { Workspace } from "@/lib/api/types";
import { can, type Capability } from "@/lib/domain/permissions";

interface WorkspaceContextValue {
  workspace: Workspace;
  workspaceId: string;
  slug: string;
  base: string;
  can: (capability: Capability) => boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  workspace,
  children,
}: {
  workspace: Workspace;
  children: ReactNode;
}) {
  // GAP-02: scope collection requests to this workspace. Set during render so the very
  // first child query already carries the header.
  if (apiClient.getWorkspace() !== workspace.id) apiClient.setWorkspace(workspace.id);
  const value: WorkspaceContextValue = {
    workspace,
    workspaceId: workspace.id,
    slug: workspace.slug,
    base: `/w/${workspace.slug}`,
    can: (capability) => can(workspace.role, capability),
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside a workspace route");
  return ctx;
}

export function useWorkspaceId(): string {
  return useWorkspace().workspaceId;
}

/** For components that may render outside a workspace (e.g. command palette). */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}
