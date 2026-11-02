"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  FileX2,
  Info,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { MetaList, PageContainer, SectionTitle } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Card, CardBody, CardHeader, Mono, Progress, SkeletonRows } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { createIdempotencyKey } from "@/lib/api/client";
import { qk, useIndexStatus, useRepository } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type { IndexStatus, Repository } from "@/lib/api/types";
import { indexingMeta } from "@/lib/domain/status";
import { notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { formatDateTime, formatNumber, formatRelative, humanizeReason } from "./repo-format";
import { useRepoId } from "./repo-layout";

function IndexProgress({ status }: { status: IndexStatus }) {
  const meta = indexingMeta(status.indexing_status);
  if (!meta.working) return null;
  const p = status.progress;
  const pct = p && p.total_files ? (p.processed_files / p.total_files) * 100 : 4;
  return (
    <Card className="border-info-border">
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium text-fg" aria-live="polite">
            {p?.phase ?? "Waiting for an indexing worker"}…
          </span>
          {p && (
            <span className="text-xs text-fg-muted tabular">
              {formatNumber(p.processed_files)} / {formatNumber(p.total_files)} files
            </span>
          )}
        </div>
        <Progress value={pct} label="Indexing progress" />
        <p className="text-xs text-fg-muted">
          Indexing runs in the background. You can leave this page.
        </p>
      </CardBody>
    </Card>
  );
}

function CoverageCard({ status }: { status: IndexStatus }) {
  return (
    <Card>
      <CardHeader
        title="Language coverage"
        description="Syntax-aware parsing is available only for supported languages."
      />
      {status.languages.length === 0 ? (
        <p className="p-4 text-sm text-fg-muted">No files classified yet.</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Language coverage</caption>
          <thead className="text-left text-xs text-fg-muted">
            <tr className="border-b border-border">
              <th scope="col" className="px-4 py-2 font-medium">
                Language
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Indexed
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Parser
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {status.languages.map((l) => (
              <tr key={l.language}>
                <td className="px-4 py-2 font-medium text-fg capitalize">{l.language}</td>
                <td className="px-4 py-2 text-right text-fg-muted tabular">
                  {l.indexed_files}/{l.files}
                </td>
                <td className="px-4 py-2">
                  {l.parser_supported ? (
                    <Badge tone="success">Tree-sitter</Badge>
                  ) : (
                    <Badge tone="neutral">Text only</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ExclusionsCard({ status, repo }: { status: IndexStatus; repo: Repository }) {
  const { can } = useWorkspace();
  const queryClient = useQueryClient();
  const { workspaceId } = useWorkspace();
  const [value, setValue] = useState((repo.settings.exclude_paths ?? []).join("\n"));
  const save = useMutation({
    mutationFn: () =>
      api.repositories.update(repo.id, {
        settings: {
          exclude_paths: value
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => {
      toast.success("Exclusion rules saved", {
        description: "They apply from the next indexing run.",
      });
      void queryClient.invalidateQueries({ queryKey: qk.repository(workspaceId, repo.id) });
    },
    onError: (e) => notifyError(e),
  });
  return (
    <Card>
      <CardHeader title="Excluded from indexing" description="Never embedded or sent to a model." />
      <CardBody className="flex flex-col gap-4">
        {status.exclusions.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {status.exclusions.map((e) => (
              <li key={e.reason}>
                <Badge tone={e.reason === "secret" ? "warning" : "neutral"} size="md">
                  <FileX2 className="size-3" /> {humanizeReason(e.reason)} · {e.files}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">No files excluded.</p>
        )}
        {can("repositories.manage") && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
            className="flex flex-col gap-2"
          >
            <Field
              label="Additional excluded paths"
              hint="One relative path prefix per line, e.g. vendor/ or src/generated/"
            >
              <Textarea
                rows={3}
                className="font-mono text-xs"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <Button type="submit" size="sm" className="self-end" loading={save.isPending}>
              Save rules
            </Button>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function DangerZone({ repo }: { repo: Repository }) {
  const { base, workspaceId } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => api.repositories.disconnect(repo.id),
    onSuccess: async () => {
      toast.success(`${repo.full_name} disconnected`, {
        description: "Indexing stopped and future access is revoked.",
      });
      await queryClient.invalidateQueries({ queryKey: qk.repositories(workspaceId) });
      router.push(`${base}/repositories`);
    },
    onError: (e) => notifyError(e),
  });
  return (
    <Card className="border-danger-border">
      <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-fg">Disconnect repository</p>
          <p className="text-xs text-fg-muted">
            Stops indexing and removes index data according to the retention policy. Task history is
            kept.
          </p>
        </div>
        <Button variant="secondary" className="text-danger" onClick={() => setOpen(true)}>
          <Trash2 /> Disconnect
        </Button>
      </CardBody>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Disconnect ${repo.full_name}?`}
        description="Anvaya will stop indexing this repository and schedule deletion of its snapshots and embeddings. Active runs on it will fail."
        confirmLabel="Disconnect repository"
        confirmVariant="danger"
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </Card>
  );
}

export function RepositoryOverview() {
  const repoId = useRepoId();
  const { can, workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const repo = useRepository(repoId);
  const status = useIndexStatus(repoId);

  const reindex = useMutation({
    mutationFn: () => api.repositories.queueIndex(repoId, createIdempotencyKey()),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.indexStatus(workspaceId, repoId), data);
      void queryClient.invalidateQueries({ queryKey: qk.repositories(workspaceId) });
      toast.success("Indexing queued");
    },
    onError: (e) => notifyError(e, "Couldn't start indexing"),
  });

  // When indexing finishes, refresh the repository header (status + commit).
  const indexing = status.data?.indexing_status;
  useEffect(() => {
    if (indexing === "ready" || indexing === "partial" || indexing === "failed") {
      void queryClient.invalidateQueries({ queryKey: qk.repository(workspaceId, repoId) });
      void queryClient.invalidateQueries({ queryKey: qk.repositories(workspaceId) });
    }
  }, [indexing, queryClient, workspaceId, repoId]);

  if (repo.isPending || status.isPending) {
    return (
      <PageContainer wide>
        <SkeletonRows rows={8} />
      </PageContainer>
    );
  }
  if (status.isError) return <ErrorState error={status.error} onRetry={() => status.refetch()} />;
  if (repo.isError) return null;

  const s = status.data;
  const r = repo.data;
  const meta = indexingMeta(s.indexing_status);
  const snap = s.snapshot;

  return (
    <PageContainer wide>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Index health</SectionTitle>
        {can("repositories.index") && (
          <Button
            size="sm"
            onClick={() => reindex.mutate()}
            loading={reindex.isPending}
            disabled={meta.working || r.status !== "connected"}
          >
            <RefreshCw /> {s.indexing_status === "pending" ? "Start indexing" : "Re-index"}
          </Button>
        )}
      </div>

      <IndexProgress status={s} />
      {s.indexing_status === "pending" && (
        <InlineAlert tone="info" icon={<Info />} title="Not indexed yet">
          Indexing fetches a snapshot of{" "}
          <code className="font-mono text-xs">{r.default_branch}</code>, classifies files, parses
          supported languages, and creates local embeddings.
        </InlineAlert>
      )}
      {s.indexing_status === "failed" && (
        <InlineAlert tone="danger" icon={<XCircle />} title="Indexing failed">
          The last run did not complete. Retry, or check the errors below.
        </InlineAlert>
      )}
      {s.indexing_status === "partial" && (
        <InlineAlert tone="warning" icon={<AlertTriangle />} title="Partially indexed">
          Some files could not be parsed. Answers will say when evidence may be missing.
        </InlineAlert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-6">
          <CoverageCard status={s} />
          {(s.limitations.length > 0 || s.errors.length > 0) && (
            <Card>
              <CardHeader
                title="Known limitations"
                description="Shown so you know what Anvaya can't see (FR-REP-009)."
              />
              <ul className="divide-y divide-border text-sm">
                {s.limitations.map((l) => (
                  <li key={l} className="flex gap-2.5 px-4 py-2.5 text-fg">
                    <Info className="mt-0.5 size-4 shrink-0 text-info" />
                    {l}
                  </li>
                ))}
                {s.errors.map((e, i) => (
                  <li key={`${e.path}-${i}`} className="flex gap-2.5 px-4 py-2.5">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                    <span className="min-w-0">
                      {e.path && <Mono className="block text-fg">{e.path}</Mono>}
                      <span className="text-fg-muted">{e.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <ExclusionsCard status={s} repo={r} />
        </div>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Snapshot" />
            <CardBody>
              {snap ? (
                <MetaList
                  items={[
                    {
                      label: "Commit",
                      value: <Mono title={snap.commit_sha}>{snap.commit_sha.slice(0, 12)}</Mono>,
                    },
                    { label: "Branch", value: snap.branch_name ?? "—" },
                    { label: "Status", value: <span className="capitalize">{snap.status}</span> },
                    {
                      label: "Files indexed",
                      value: (
                        <span className="tabular">
                          {formatNumber(snap.indexed_files)} / {formatNumber(snap.total_files)}
                        </span>
                      ),
                    },
                    {
                      label: "Excluded",
                      value: <span className="tabular">{formatNumber(snap.excluded_files)}</span>,
                    },
                    { label: "Parser", value: <Mono>{snap.parser_version ?? "—"}</Mono> },
                    { label: "Chunker", value: <Mono>{snap.chunker_version ?? "—"}</Mono> },
                    { label: "Embeddings", value: <Mono>{s.embedding_model ?? "—"}</Mono> },
                    {
                      label: "Indexed",
                      value: (
                        <span title={formatDateTime(r.indexed_at)}>
                          {formatRelative(r.indexed_at)}
                        </span>
                      ),
                    },
                  ]}
                />
              ) : (
                <p className="text-sm text-fg-muted">No snapshot yet.</p>
              )}
            </CardBody>
          </Card>
          {snap && s.indexing_status === "ready" && (
            <p className="flex items-center gap-2 text-xs text-fg-muted">
              <CheckCircle2 className="size-3.5 text-success" /> Citations resolve against commit{" "}
              {snap.commit_sha.slice(0, 7)}.
            </p>
          )}
          {can("repositories.manage") && <DangerZone repo={r} />}
        </div>
      </div>
    </PageContainer>
  );
}
