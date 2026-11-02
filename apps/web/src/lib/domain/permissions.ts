import type { WorkspaceRole } from "@/lib/api/types";

/**
 * UI affordance rules. These only decide what the interface offers; the server
 * enforces authorization on every request (SECURITY.md §5 — never rely on hiding).
 */
const RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export type Capability =
  | "workspace.manage"
  | "members.manage"
  | "integrations.manage"
  | "repositories.manage"
  | "repositories.index"
  | "ai_policy.manage"
  | "audit.view"
  | "tasks.create"
  | "runs.operate"
  | "approvals.decide"
  | "knowledge.write";

const MIN_ROLE: Record<Capability, WorkspaceRole> = {
  "workspace.manage": "admin",
  "members.manage": "admin",
  "integrations.manage": "admin",
  "repositories.manage": "admin",
  "repositories.index": "member",
  "ai_policy.manage": "admin",
  "audit.view": "admin",
  "tasks.create": "member",
  "runs.operate": "member",
  "approvals.decide": "member",
  "knowledge.write": "member",
};

export function can(role: WorkspaceRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[MIN_ROLE[capability]];
}

export function requiredRole(capability: Capability): WorkspaceRole {
  return MIN_ROLE[capability];
}

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "Full control, including ownership transfer.",
  admin: "Manage members, integrations, repositories, and AI policy.",
  member: "Create tasks, run workflows, and approve plans and pull requests.",
  viewer: "Read-only access to repositories, runs, and reviews.",
};
