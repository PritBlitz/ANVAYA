/**
 * Compile-time contract check (I-8 / R7). `generated/openapi.ts` is generated from the
 * backend's `apps/api/openapi.json` (`npm run gen:api`), whose response schemas are
 * enforced against real responses in the backend test suite. Every hand-written wire
 * type the UI reads must accept what the server documents: if the backend renames,
 * drops or retypes a field the UI depends on, `npm run typecheck` fails here.
 *
 * The check is one-directional on purpose (server ⊆ wire): wire types may be looser
 * (optional fields, `string` for enums) so the UI degrades gracefully on additions.
 */
import type { paths } from "./generated/openapi";
import type * as T from "./types";
import type * as W from "./wire";

type Success<R> = R extends { 200: infer X }
  ? X
  : R extends { 201: infer X }
    ? X
    : R extends { 202: infer X }
      ? X
      : never;

type Data<P extends keyof paths, M extends keyof paths[P]> =
  Success<paths[P][M] extends { responses: infer R } ? R : never> extends {
    content: { "application/json": { data: infer D } };
  }
    ? D
    : never;

type Item<D> = D extends readonly (infer I)[] ? I : never;

/**
 * The backend derives schemas from real responses, so enum fields are documented as
 * plain strings. Widen the wire type's string literals for the comparison: field
 * presence, nullability and primitive types are still checked.
 */
type Widen<T> = T extends string
  ? string
  : T extends boolean
    ? boolean
    : T extends readonly (infer I)[]
      ? Widen<I>[]
      : T extends object
        ? { [K in keyof T]: Widen<T[K]> }
        : T;

/**
 * Fields the backend documents only as `unknown` / free-form objects can't be checked;
 * they are relaxed here and listed in docs/frontend/API_INTEGRATION.md (R7).
 */
type Relax<S> = unknown extends S
  ? any // eslint-disable-line @typescript-eslint/no-explicit-any
  : S extends readonly (infer I)[]
    ? Relax<I>[]
    : S extends object
      ? string extends keyof S
        ? any // eslint-disable-line @typescript-eslint/no-explicit-any
        : { [K in keyof S]: Relax<S[K]> }
      : S;

/** Fails to compile unless every documented server response fits the wire type. */
type Fits<Server, Wire> = [Server] extends [never]
  ? "route has no documented response"
  : [Relax<Server>] extends [Widen<Wire>]
    ? true
    : { server: Server; wire: Wire };
type Expect<T extends true> = T;

export type ContractChecks = [
  Expect<Fits<Data<"/auth/providers", "get">, W.WProviders>>,
  Expect<Fits<Data<"/auth/dev-login", "post">, W.WDevLogin>>,
  Expect<Fits<Data<"/me", "get">, W.WMe>>,
  Expect<Fits<Item<Data<"/workspaces", "get">>, W.WWorkspace>>,
  Expect<Fits<Data<"/workspaces", "post">, W.WWorkspace>>,
  Expect<Fits<Data<"/workspaces/{workspaceId}", "get">, W.WWorkspace>>,
  Expect<Fits<Item<Data<"/workspaces/{workspaceId}/members", "get">>, W.WMember>>,
  Expect<Fits<Data<"/workspaces/{workspaceId}/invitations", "post">, W.WInvitation>>,
  Expect<Fits<Item<Data<"/workspaces/{workspaceId}/invitations", "get">>, W.WInvitation>>,
  Expect<Fits<Item<Data<"/workspaces/{workspaceId}/audit-events", "get">>, W.WAuditEvent>>,
  Expect<Fits<Data<"/workspaces/{workspaceId}/ai-policy", "get">, W.WAiPolicy>>,
  Expect<Fits<Data<"/workspaces/{workspaceId}/usage", "get">, W.WUsage>>,
  Expect<Fits<Data<"/ai/providers/health-check", "post">, W.WProviderHealth>>,
  Expect<Fits<Data<"/integrations/github/install-url", "get">, W.WInstallUrl>>,
  Expect<Fits<Data<"/integrations/github/complete", "post">, W.WInstallation>>,
  Expect<Fits<Item<Data<"/integrations/github/installations", "get">>, W.WInstallation>>,
  Expect<
    Fits<
      Data<"/integrations/github/installations/{id}/repositories", "get">,
      W.WAvailableRepositoriesPage
    >
  >,
  Expect<Fits<Item<Data<"/repositories", "get">>, W.WRepository>>,
  Expect<Fits<Data<"/repositories", "post">, W.WRepository>>,
  Expect<Fits<Data<"/repositories/{repositoryId}", "get">, W.WRepository>>,
  Expect<Fits<Data<"/repositories/{repositoryId}/index-status", "get">, W.WIndexStatus>>,
  Expect<Fits<Data<"/repositories/{repositoryId}/tree", "get">, W.WTree>>,
  Expect<Fits<Data<"/repositories/{repositoryId}/files/content", "get">, W.WFile>>,
  Expect<Fits<Data<"/repositories/{repositoryId}/search", "post">, W.WSearch>>,
  Expect<Fits<Item<Data<"/repositories/{repositoryId}/symbols", "get">>, W.WSymbol>>,
  Expect<Fits<Data<"/repositories/{repositoryId}/symbols/{symbolId}", "get">, W.WSymbolDetail>>,
  Expect<Fits<Data<"/repositories/{repositoryId}/dependency-map", "get">, W.WDependencyMap>>,
  Expect<Fits<Data<"/repositories/{repositoryId}/questions", "post">, W.WQuestionAnswer>>,
  Expect<Fits<Item<Data<"/repositories/{repositoryId}/questions", "get">>, W.WQuestionHistoryItem>>,
  Expect<Fits<Data<"/questions/{questionId}", "get">, W.WQuestionHistoryItem>>,
  Expect<Fits<Item<Data<"/repositories/{repositoryId}/knowledge", "get">>, W.WKnowledge>>,
  Expect<Fits<Data<"/repositories/{repositoryId}/knowledge", "post">, W.WKnowledge>>,
  Expect<Fits<Data<"/knowledge/{documentId}", "get">, W.WKnowledge>>,
  Expect<Fits<Data<"/repositories/{repositoryId}/tasks", "post">, W.WTask>>,
  Expect<Fits<Item<Data<"/tasks", "get">>, W.WTask>>,
  Expect<Fits<Data<"/tasks/{taskId}", "get">, W.WTask>>,
  Expect<Fits<Data<"/tasks/{taskId}/runs", "post">, W.WRun>>,
  Expect<Fits<Item<Data<"/tasks/{taskId}/runs", "get">>, W.WRun>>,
  Expect<Fits<Item<Data<"/runs", "get">>, W.WRunListItem>>,
  Expect<Fits<Data<"/runs/{runId}", "get">, W.WRun>>,
  Expect<Fits<Data<"/runs/{runId}/cancel", "post">, W.WRun>>,
  Expect<Fits<Data<"/runs/{runId}/retry", "post">, W.WRun>>,
  Expect<Fits<Item<Data<"/runs/{runId}/steps", "get">>, W.WStep>>,
  Expect<Fits<Data<"/runs/{runId}/artifacts", "get">, W.WArtifacts>>,
  Expect<Fits<Data<"/runs/{runId}/plan", "get">, W.WPlan>>,
  Expect<Fits<Data<"/runs/{runId}/plan", "patch">, W.WPlanRevision>>,
  Expect<Fits<Data<"/runs/{runId}/diff", "get">, W.WDiff>>,
  Expect<Fits<Data<"/runs/{runId}/verification", "get">, W.WVerification>>,
  Expect<Fits<Data<"/runs/{runId}/review", "get">, W.WReview>>,
  Expect<
    Fits<Data<"/runs/{runId}/findings/{findingId}/disposition", "post">, W.WFindingDisposition>
  >,
  Expect<Fits<Data<"/runs/{runId}/pull-request", "post">, W.WPullRequest>>,
];

/**
 * Exact enum checks for values the UI branches on. A new server value the UI doesn't
 * know about fails typecheck here, so status/label maps can't silently miss it.
 */
type Subset<Server, Ui> = [Server] extends [Ui] ? true : { unknown_to_ui: Exclude<Server, Ui> };
type RunStatusOf = Data<"/runs/{runId}", "get">["status"];
type ModeOf = Data<"/workspaces/{workspaceId}/ai-policy", "get">["default_mode"];
type IndexingOf = Item<Data<"/repositories", "get">>["indexing_status"];
type SeverityOf = Item<Data<"/runs/{runId}/review", "get">["deterministic_findings"]>["severity"];
type FindingStatusOf = Item<Data<"/runs/{runId}/review", "get">["ai_findings"]>["status"];
type SymbolKindOf = Item<Data<"/repositories/{repositoryId}/symbols", "get">>["kind"];
type CitationSourceOf = Item<
  Data<"/repositories/{repositoryId}/questions", "post">["citations"]
>["source"];

type ActorTypeOf = Item<Data<"/workspaces/{workspaceId}/audit-events", "get">>["actor_type"];
type InstallationStatusOf = Item<Data<"/integrations/github/installations", "get">>["status"];
type VisibilityOf = NonNullable<Item<Data<"/repositories", "get">>["visibility"]>;
type PlanSourceOf = Data<"/runs/{runId}/plan", "get">["source"];
type FindingSourceOf = Item<
  Data<"/runs/{runId}/review", "get">["deterministic_findings"]
>["source"];

export type EnumChecks = [
  Expect<Subset<ActorTypeOf, T.AuditEvent["actor_type"]>>,
  Expect<Subset<InstallationStatusOf, T.InstallationStatus>>,
  Expect<Subset<VisibilityOf, T.RepositoryVisibility>>,
  Expect<Subset<PlanSourceOf, T.RunPlan["source"]>>,
  Expect<Subset<FindingSourceOf, T.FindingSource>>,
  Expect<Subset<RunStatusOf, T.RunStatus>>,
  Expect<Subset<ModeOf, T.InferenceMode>>,
  Expect<Subset<IndexingOf, T.IndexingStatus>>,
  Expect<Subset<SeverityOf, T.Severity>>,
  Expect<Subset<FindingStatusOf, T.FindingStatus>>,
  Expect<Subset<SymbolKindOf, T.SymbolKind>>,
  Expect<Subset<CitationSourceOf, T.Citation["source"]>>,
];
