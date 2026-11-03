/**
 * UI models for work package B (releases/V1.md): workflow templates, call graph, change-impact
 * prediction and test selection, workspace-wide knowledge search, hosted provider choice.
 *
 * For these endpoints the wire format is the UI model (no renaming), so `wire.ts` reuses these
 * types and `contract.ts` checks them against the generated OpenAPI types. Re-exported from
 * `types.ts`.
 */
import type { EvidenceRef, InferenceMode, ISODateTime, RunBudgets, UUID } from "./types";

export const TEMPLATE_WORKFLOWS = ["change", "migration_plan"] as const;
export type TemplateWorkflow = (typeof TEMPLATE_WORKFLOWS)[number];

export interface TemplateTaskDefaults {
  title_prefix: string | null;
  description_template: string | null;
  labels: string[];
}

/** Workflow template: application policy (built-in) or workspace policy (admin-managed). */
export interface WorkflowTemplate {
  key: string;
  /** null for built-in templates. */
  id: UUID | null;
  source: "builtin" | "workspace";
  name: string;
  description: string;
  workflow: TemplateWorkflow;
  /** Plan-only (migration plan): the run ends at the approved plan and nothing is executed. */
  plan_only: boolean;
  task_defaults: TemplateTaskDefaults;
  /** Budget ceilings; they can only lower the workspace limits. */
  budget: Partial<RunBudgets>;
  /** Allowed verification profiles; null = every applicable profile. */
  allowed_profiles: string[] | null;
  planning_guidance: string[];
  version: number;
  status: "active" | "archived";
  created_at: ISODateTime | null;
  updated_at: ISODateTime | null;
}

/** Immutable copy of a template stored on a task when it was created. */
export interface TemplateSnapshot {
  key: string;
  name: string;
  description: string;
  workflow: TemplateWorkflow;
  task_defaults: TemplateTaskDefaults;
  budget: Partial<RunBudgets>;
  allowed_profiles: string[] | null;
  planning_guidance: string[];
  source: "builtin" | "workspace";
  template_id: string | null;
  version: number;
}

export interface RunTemplateRef {
  key: string;
  name: string;
  workflow: TemplateWorkflow;
  source: "builtin" | "workspace";
  version: number;
}

export interface CreateTemplateRequest {
  key: string;
  name: string;
  description?: string;
  workflow: TemplateWorkflow;
  task_defaults?: TemplateTaskDefaults;
  budget?: Partial<RunBudgets>;
  allowed_profiles?: string[] | null;
  planning_guidance?: string[];
}

export type UpdateTemplateRequest = Partial<Omit<CreateTemplateRequest, "key">> & {
  status?: "active" | "archived";
};

/** Server-defined verification profile ids (apps/api/src/execution/profiles.ts). */
export const VERIFICATION_PROFILE_IDS = [
  "python-compile",
  "python-unittest",
  "node-syntax",
  "node-test",
  "npm-test",
  "python-pytest",
] as const;

/** Migration-plan section of a plan (plan-only workflow). */
export interface MigrationSection {
  affected_areas: { area: string; description: string; files: string[]; evidence_ids: string[] }[];
  prerequisites: string[];
  step_rollback: { step_id: string; rollback: string }[];
  rollback_strategy: string[];
}

export interface MigrationEvidenceRef extends EvidenceRef {
  id: string;
  content_hash?: string;
  symbol: string | null;
}

/** Heuristic test selection recorded on a verification result (null = the full profile ran). */
export interface TestSelection {
  mode: "narrow";
  heuristic: true;
  files: string[];
  reasons: Record<string, string>;
  test_files_total: number;
  not_run: number;
}

export interface SymbolRef {
  id: UUID;
  name: string;
  qualified_name: string | null;
  kind: string;
  path: string;
  start_line: number;
  end_line: number;
}

export type CallGraphDirection = "callers" | "callees" | "both";

export interface CallGraph {
  snapshot_id: UUID;
  commit_sha: string;
  root: SymbolRef;
  direction: CallGraphDirection;
  depth: number;
  nodes: { symbol: SymbolRef; depth: number; direction: "caller" | "callee" }[];
  /** Call sites: `path`/`line` are in the calling symbol's file. */
  edges: { source_id: UUID; target_id: UUID; type: string; line: number | null; path: string }[];
  unresolved_callees: { name: string; type: string; line: number | null }[];
  total_nodes: number;
  next_cursor: string | null;
  truncated: boolean;
  limitations: string[];
}

export type ImpactEvidenceStep =
  | { kind: "imports"; from: string; to: string; line: number | null }
  | { kind: "calls"; from: string; to: string; line: number | null; caller: string; callee: string }
  | { kind: "changed"; path: string }
  | { kind: "naming"; from: string; to: string };

export interface SelectedTest {
  path: string;
  /** Heuristic ranking score in [0, 1]; not a probability and not a correctness claim. */
  score: number;
  reasons: {
    kind: "changed" | "imports" | "calls" | "naming";
    description: string;
    evidence: ImpactEvidenceStep[];
  }[];
}

export interface ImpactCore {
  heuristic: true;
  disclaimer: string;
  changed_files: { path: string; indexed: boolean; symbols: number }[];
  changed_symbols: SymbolRef[];
  impacted_files: {
    path: string;
    distance: number;
    reason: "imports" | "calls";
    evidence: ImpactEvidenceStep[];
  }[];
  impacted_symbols: { symbol: SymbolRef; depth: number; evidence: ImpactEvidenceStep[] }[];
  selected_tests: SelectedTest[];
  test_files_total: number;
  truncated: boolean;
  limitations: string[];
}

export interface ImpactPrediction extends ImpactCore {
  snapshot_id: UUID;
  commit_sha: string;
  source: "request";
}

export interface RunImpact extends ImpactCore {
  run_id: UUID;
  /** What was analysed: the latest applied patch, or the plan's files before a patch exists. */
  source: "patch" | "plan" | "none";
  patch_id: UUID | null;
  plan_version: number | null;
  snapshot_id: UUID | null;
  commit_sha: string | null;
  applied_selections: { profile_id: string; attempt: number; selection: Record<string, unknown> }[];
}

export interface WorkspaceSearchResult {
  source: "code" | "knowledge";
  repository_id: UUID;
  repository_full_name: string;
  commit_sha: string | null;
  path: string | null;
  start_line: number;
  end_line: number;
  content_hash: string;
  symbol: string | null;
  language: string | null;
  knowledge_document_id: UUID | null;
  title: string | null;
  snippet: string;
  score: number;
}

export interface WorkspaceRepositorySummary {
  id: UUID;
  full_name: string;
  commit_sha: string;
  results: number;
  semantic: string;
}

export interface WorkspaceSearchResponse {
  query: string;
  results: WorkspaceSearchResult[];
  repositories: WorkspaceRepositorySummary[];
  skipped_repositories: { id: UUID; full_name: string; reason: string }[];
  retrieval: { mode: "hybrid" | "lexical"; repositories_searched: number; duration_ms: number };
  limitations: string[];
}

export interface WorkspaceAnswer {
  answer: string;
  insufficient_evidence: boolean;
  citations: (WorkspaceSearchResult & { evidence_id: string; supports: string })[];
  limitations: string[];
  repositories: WorkspaceRepositorySummary[];
  skipped_repositories: { id: UUID; full_name: string; reason: string }[];
  provider: string | null;
  model: string | null;
  mode: InferenceMode;
  prompt_version: string | null;
  data_disclosure: { provider: string | null; data_categories: string[] } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    schema_repair_attempted: boolean;
  } | null;
}

export interface WorkspaceSearchRequest {
  query: string;
  repository_ids?: UUID[];
  top_k?: number;
  per_repository?: number;
  include_knowledge?: boolean;
  mode?: "hybrid" | "lexical";
}

export interface WorkspaceAskRequest {
  question: string;
  repository_ids?: UUID[];
  mode?: InferenceMode;
  top_k?: number;
  include_knowledge?: boolean;
}

/** Hosted (cloud) providers the server has adapters for; which are configured is server-side. */
export const HOSTED_PROVIDERS = ["anthropic", "openai_compatible"] as const;
export type HostedProvider = (typeof HOSTED_PROVIDERS)[number];

export const HOSTED_PROVIDER_INFO: Record<
  HostedProvider,
  { label: string; recipient: string; modelHint: string }
> = {
  anthropic: {
    label: "Anthropic (Claude)",
    recipient: "Anthropic's hosted Claude API",
    modelHint: "e.g. claude-opus-5-5",
  },
  openai_compatible: {
    label: "OpenAI-compatible endpoint",
    recipient:
      "the OpenAI-compatible endpoint your operator configured (OpenAI, or a self-hosted server such as vLLM)",
    modelHint: "the model name your operator configured",
  },
};
