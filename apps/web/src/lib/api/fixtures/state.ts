/**
 * DEVELOPMENT FIXTURE — in-memory state for the fixture adapter.
 * Persisted to localStorage so reloads keep the session and created records.
 */
import type * as T from "../types";
import type * as W from "../wire";

export interface FixtureMembership {
  workspace_id: string;
  user_id: string;
  role: T.WorkspaceRole;
  created_at: string;
}

export type Scoped<X> = X & { workspace_id: string };

export interface ScheduledTransition {
  status: T.RunStatus;
  at: number;
}

export interface FixtureRun extends T.WorkflowRun {
  workspace_id: string;
  outcome: "success" | "verification_failed";
  schedule: ScheduledTransition[];
  events: T.RunEvent[];
  steps: T.AgentStep[];
  plan: T.RunPlan | null;
  diff: T.RunDiff | null;
  verification: T.VerificationReport | null;
  review: T.ReviewReport | null;
  approvals: T.Approval[];
  pr_approved: boolean;
  artifacts: T.RunArtifact[];
}

export interface IndexJob {
  id: string;
  started_at: number;
  duration_ms: number;
  commit_sha: string;
}

export interface FixtureWorkspace extends Omit<T.Workspace, "role"> {
  settings: W.WWorkspace["settings"];
  updated_at: string;
}

/** Server-held GitHub install state (single-use, expires; GAP-14). */
export interface InstallState {
  workspace_id: string;
  user_id: string;
  expires_at: number;
  used: boolean;
}

export interface FixtureState {
  version: number;
  seq: number;
  session_user_id: string | null;
  users: T.User[];
  workspaces: FixtureWorkspace[];
  memberships: FixtureMembership[];
  invitations: Scoped<T.Invitation & { token: string }>[];
  install_states: Record<string, InstallState>;
  installations: Scoped<T.GitInstallation>[];
  available: T.AvailableRepository[];
  repositories: Scoped<T.Repository>[];
  index_jobs: Record<string, IndexJob>;
  knowledge: Scoped<T.KnowledgeDocument & { content: string }>[];
  tasks: Scoped<T.EngineeringTask>[];
  runs: FixtureRun[];
  policies: Record<string, T.AiPolicy>;
  audit: Scoped<T.AuditEvent>[];
  usage: Scoped<{
    provider: string;
    model: string;
    mode: T.InferenceMode;
    operation: string;
    input_tokens: number;
    output_tokens: number;
    cost: number;
    at: string;
    run_id: string | null;
  }>[];
  idempotency: Record<string, { fingerprint: string; status: number; body: unknown }>;
}

export const FIXTURE_STATE_VERSION = 4;

export const IDS = {
  user: "00000000-0000-4000-8000-000000000001",
  userViewer: "00000000-0000-4000-8000-000000000002",
  userMember: "00000000-0000-4000-8000-000000000003",
  workspace: "10000000-0000-4000-8000-000000000001",
  installation: "20000000-0000-4000-8000-000000000001",
  repoPayments: "30000000-0000-4000-8000-000000000001",
  repoMl: "30000000-0000-4000-8000-000000000002",
} as const;

export const PAYMENTS_SHA = "9f3c2a17e4b5d8061c2e7a9b4f1d3e5c7a8b9c0d";
export const ML_SHA = "4e8a1c93b27f6d05e1a2c3b4d5e6f708192a3b4c";

export function daysAgo(days: number, hours = 0): string {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();
}

/** Mirrors the backend's DEFAULT_RUN_BUDGET (apps/api/src/runs/run.schemas.ts). */
export const DEFAULT_BUDGETS: T.RunBudgets = {
  max_steps: 8,
  max_input_tokens: 6000,
  max_output_tokens: 1024,
  max_duration_seconds: 900,
  max_changed_files: 8,
  max_repair_attempts: 1,
};

export const LOCAL_MODEL = "qwen2.5-coder:7b";
export const EMBEDDING_MODEL = "nomic-embed-text";

/** Mirrors the backend's DEFAULT_AI_POLICY: local-first, no cloud. */
export function defaultPolicy(): T.AiPolicy {
  return {
    default_mode: "local",
    allowed_modes: ["local", "mock"],
    cloud: { enabled: false, provider: null, model: null, data_categories: [] },
    limits: { max_input_tokens: 6000, max_output_tokens: 1024, request_timeout_seconds: 300 },
  };
}

export function createSeedState(): FixtureState {
  const users: T.User[] = [
    { id: IDS.user, email: "ira.shah@acme.dev", display_name: "Ira Shah", avatar_url: null },
    {
      id: IDS.userViewer,
      email: "dev.patel@acme.dev",
      display_name: "Dev Patel",
      avatar_url: null,
    },
    { id: IDS.userMember, email: "mei.lin@acme.dev", display_name: "Mei Lin", avatar_url: null },
  ];
  const ws = IDS.workspace;
  return {
    version: FIXTURE_STATE_VERSION,
    seq: 1000,
    session_user_id: null,
    users,
    workspaces: [
      {
        id: ws,
        name: "Acme Engineering",
        slug: "acme",
        plan_key: "team",
        settings: {},
        created_at: daysAgo(40),
        updated_at: daysAgo(12),
      },
    ],
    memberships: [
      { workspace_id: ws, user_id: IDS.user, role: "owner", created_at: daysAgo(40) },
      { workspace_id: ws, user_id: IDS.userMember, role: "member", created_at: daysAgo(30) },
      { workspace_id: ws, user_id: IDS.userViewer, role: "viewer", created_at: daysAgo(9) },
    ],
    invitations: [],
    install_states: {},
    installations: [
      {
        id: IDS.installation,
        workspace_id: ws,
        provider: "github",
        external_installation_id: 51_200_431,
        account_login: "acme",
        account_type: "Organization",
        granted_permissions: {
          contents: "write",
          pull_requests: "write",
          issues: "read",
          metadata: "read",
        },
        status: "active",
        created_at: daysAgo(38),
      },
    ],
    available: [
      repoAvailable(810_001, "payments-api", "private"),
      repoAvailable(810_002, "ml-pipeline", "private"),
      repoAvailable(810_003, "web-console", "private"),
      repoAvailable(810_004, "infra-terraform", "internal"),
      repoAvailable(810_005, "docs-site", "public"),
    ],
    repositories: [
      {
        id: IDS.repoPayments,
        workspace_id: ws,
        installation_id: IDS.installation,
        provider: "github",
        external_repository_id: 810_001,
        owner: "acme",
        name: "payments-api",
        full_name: "acme/payments-api",
        default_branch: "main",
        visibility: "private",
        status: "connected",
        indexing_status: "ready",
        latest_indexed_commit_sha: PAYMENTS_SHA,
        indexed_at: daysAgo(0, 3),
        settings: { exclude_paths: ["dist/", "coverage/"], verification_profiles: [] },
        created_at: daysAgo(37),
        updated_at: daysAgo(0, 3),
      },
      {
        id: IDS.repoMl,
        workspace_id: ws,
        installation_id: IDS.installation,
        provider: "github",
        external_repository_id: 810_002,
        owner: "acme",
        name: "ml-pipeline",
        full_name: "acme/ml-pipeline",
        default_branch: "main",
        visibility: "private",
        status: "connected",
        indexing_status: "partial",
        latest_indexed_commit_sha: ML_SHA,
        indexed_at: daysAgo(2),
        settings: {},
        created_at: daysAgo(20),
        updated_at: daysAgo(2),
      },
    ],
    index_jobs: {},
    knowledge: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        workspace_id: ws,
        repository_id: IDS.repoPayments,
        source_type: "architecture",
        external_id: null,
        title: "docs/architecture.md",
        content_hash: "sha256:7a1f0c",
        source_url: null,
        indexed_at: daysAgo(0, 3),
        created_at: daysAgo(37),
        content:
          "Modules: src/auth (session refresh, rotating refresh tokens), src/payments (charges, money, webhooks), src/lib (http, logger).",
      },
      {
        id: "40000000-0000-4000-8000-000000000002",
        workspace_id: ws,
        repository_id: IDS.repoPayments,
        source_type: "decision",
        external_id: "ADR-006",
        title: "ADR-006: Idempotent charges at the processor boundary",
        content_hash: "sha256:22be91",
        source_url: null,
        indexed_at: daysAgo(5),
        created_at: daysAgo(14),
        content:
          "Every charge request sent to the processor must carry an idempotency key derived from the order id so network retries can never double-charge a customer.",
      },
    ],
    tasks: [],
    runs: [],
    policies: { [ws]: defaultPolicy() },
    audit: [],
    usage: [],
    idempotency: {},
  };
}

function repoAvailable(
  id: number,
  name: string,
  visibility: T.RepositoryVisibility,
): T.AvailableRepository {
  return {
    external_repository_id: id,
    full_name: `acme/${name}`,
    owner: "acme",
    name,
    default_branch: "main",
    visibility,
    installation_id: IDS.installation,
  };
}
