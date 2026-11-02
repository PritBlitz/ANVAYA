"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  FileText,
  GitPullRequest,
  Lightbulb,
  Network,
  NotebookPen,
  Plus,
  Trash2,
  CircleDot,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { RichText } from "@/components/domain/rich-text";
import { PageContainer, PageHeader, SectionTitle } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Card, Mono, SkeletonRows } from "@/components/ui/misc";
import {
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DrawerContent,
} from "@/components/ui/overlays";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { createIdempotencyKey } from "@/lib/api/client";
import { qk, useKnowledge, useKnowledgeDocument, useRepositories } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type { KnowledgeDocument, KnowledgeSourceType } from "@/lib/api/types";
import { applyServerErrors, notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { formatRelative } from "@/lib/utils/format";
import { useRepoId } from "@/features/repositories/repo-layout";

const SOURCE: Record<KnowledgeSourceType, { label: string; icon: ReactNode }> = {
  readme: { label: "README", icon: <FileText /> },
  architecture: { label: "Architecture", icon: <Network /> },
  decision: { label: "Decision", icon: <Lightbulb /> },
  issue: { label: "Issue", icon: <CircleDot /> },
  pull_request: { label: "Pull request", icon: <GitPullRequest /> },
  engineering_note: { label: "Engineering note", icon: <NotebookPen /> },
};

export const knowledgeSchema = z.object({
  source_type: z.enum(["engineering_note", "decision", "architecture"]),
  title: z
    .string()
    .trim()
    .min(3, "Title must be at least 3 characters")
    .max(200, "Title must be at most 200 characters"),
  content: z
    .string()
    .trim()
    .min(10, "Write at least 10 characters")
    .max(20000, "Keep notes under 20,000 characters"),
});
type KnowledgeValues = z.infer<typeof knowledgeSchema>;

function AddKnowledgeDialog({
  repoId,
  open,
  onOpenChange,
}: {
  repoId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { workspaceId } = useWorkspace();
  const key = useRef(createIdempotencyKey());
  const form = useForm<KnowledgeValues>({
    resolver: zodResolver(knowledgeSchema),
    defaultValues: { source_type: "engineering_note", title: "", content: "" },
  });
  const create = useMutation({
    mutationFn: (v: KnowledgeValues) => api.repositories.addKnowledge(repoId, v, key.current),
    onSuccess: () => {
      key.current = createIdempotencyKey();
      toast.success("Note added", { description: "It will be indexed and available as evidence." });
      void queryClient.invalidateQueries({ queryKey: qk.knowledge(workspaceId, repoId) });
      form.reset();
      onOpenChange(false);
    },
    onError: (e) => {
      key.current = createIdempotencyKey();
      applyServerErrors(e, form.setError, ["title", "content", "source_type"]);
    },
  });
  const errors = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="Add engineering knowledge"
        description="Notes and decisions are indexed with provenance and can be cited by investigations and answers."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="primary"
              type="submit"
              form="knowledge-form"
              loading={create.isPending}
            >
              Add to knowledge
            </Button>
          </>
        }
      >
        <form
          id="knowledge-form"
          noValidate
          onSubmit={form.handleSubmit((v) => create.mutate(v))}
          className="flex flex-col gap-4"
        >
          <Field label="Type" error={errors.source_type?.message}>
            <Select {...form.register("source_type")}>
              <option value="engineering_note">Engineering note</option>
              <option value="decision">Decision record</option>
              <option value="architecture">Architecture</option>
            </Select>
          </Field>
          <Field label="Title" required error={errors.title?.message}>
            <Input placeholder="ADR-007: Serialize token refresh" {...form.register("title")} />
          </Field>
          <Field
            label="Content"
            required
            hint="Markdown-style lists and `code` are supported."
            error={errors.content?.message}
          >
            <Textarea rows={8} {...form.register("content")} />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DocumentDrawer({ docId, onClose }: { docId: string | null; onClose: () => void }) {
  const doc = useKnowledgeDocument(docId);
  const { can, workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.knowledge.remove(docId!),
    onSuccess: () => {
      toast.success("Removed from knowledge");
      void queryClient.invalidateQueries({ queryKey: qk.ws(workspaceId) });
      setConfirm(false);
      onClose();
    },
    onError: (e) => notifyError(e),
  });
  return (
    <Dialog open={!!docId} onOpenChange={(o) => !o && onClose()}>
      {docId && (
        <DrawerContent
          title={doc.data?.title ?? "Document"}
          description={
            doc.data
              ? `${SOURCE[doc.data.source_type].label} · added ${formatRelative(doc.data.created_at)}`
              : undefined
          }
          actions={
            can("knowledge.write") && doc.data ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                onClick={() => setConfirm(true)}
              >
                <Trash2 /> Remove
              </Button>
            ) : null
          }
        >
          <div className="p-5">
            {doc.isPending ? (
              <SkeletonRows rows={6} />
            ) : doc.isError ? (
              <ErrorState error={doc.error} onRetry={() => doc.refetch()} />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2 text-xs text-fg-muted">
                  <Mono title={doc.data.content_hash}>{doc.data.content_hash}</Mono>
                  {doc.data.external_id && <Badge>{doc.data.external_id}</Badge>}
                  <Badge tone={doc.data.indexed_at ? "success" : "info"}>
                    {doc.data.indexed_at ? "Indexed" : "Indexing pending"}
                  </Badge>
                </div>
                {doc.data.content ? (
                  <RichText text={doc.data.content} />
                ) : (
                  <p className="text-sm text-fg-muted">
                    Content is stored in object storage and not previewable.
                  </p>
                )}
              </div>
            )}
          </div>
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title="Remove this document?"
            description="It will no longer be used as evidence. Past citations keep their recorded hash."
            confirmLabel="Remove"
            confirmVariant="danger"
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </DrawerContent>
      )}
    </Dialog>
  );
}

function KnowledgeList({
  docs,
  onOpen,
}: {
  docs: KnowledgeDocument[];
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="divide-y divide-border">
      {docs.map((d) => (
        <li key={d.id}>
          <button
            type="button"
            onClick={() => onOpen(d.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <span className="text-fg-subtle [&_svg]:size-4">{SOURCE[d.source_type].icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{d.title}</span>
              <span className="block text-xs text-fg-muted">
                {SOURCE[d.source_type].label} · {formatRelative(d.created_at)}
              </span>
            </span>
            <Badge tone={d.indexed_at ? "success" : "info"}>
              {d.indexed_at ? "Indexed" : "Pending"}
            </Badge>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RepoKnowledgeSection({ repoId, title }: { repoId: string; title?: ReactNode }) {
  const searchParams = useSearchParams();
  const { can } = useWorkspace();
  const docs = useKnowledge(repoId);
  const [adding, setAdding] = useState(false);
  // Q&A knowledge citations deep-link here with ?doc=<id>.
  const [openDoc, setOpenDoc] = useState<string | null>(() => searchParams.get("doc"));
  const addButton = can("knowledge.write") && (
    <Button size="sm" onClick={() => setAdding(true)}>
      <Plus /> Add note
    </Button>
  );
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle action={addButton}>{title ?? "Indexed knowledge"}</SectionTitle>
      <Card className="overflow-hidden">
        {docs.isPending ? (
          <SkeletonRows rows={3} className="p-4" />
        ) : docs.isError ? (
          <ErrorState compact error={docs.error} onRetry={() => docs.refetch()} />
        ) : docs.data.length === 0 ? (
          <EmptyState
            compact
            icon={<BookOpen />}
            title="No knowledge yet"
            description="Architecture docs and READMEs are indexed automatically. Add decisions and notes to capture context code can't."
          />
        ) : (
          <KnowledgeList docs={docs.data} onOpen={setOpenDoc} />
        )}
      </Card>
      <AddKnowledgeDialog repoId={repoId} open={adding} onOpenChange={setAdding} />
      <DocumentDrawer docId={openDoc} onClose={() => setOpenDoc(null)} />
    </section>
  );
}

export function RepoKnowledgeScreen() {
  const repoId = useRepoId();
  return (
    <PageContainer className="max-w-4xl">
      <RepoKnowledgeSection repoId={repoId} />
    </PageContainer>
  );
}

export function WorkspaceKnowledgeScreen() {
  const repos = useRepositories();
  const { base } = useWorkspace();
  return (
    <PageContainer className="max-w-4xl">
      <PageHeader
        title="Knowledge"
        description="Architecture documents, decisions, and engineering notes indexed alongside code, each with provenance."
      />
      {repos.isPending ? (
        <SkeletonRows rows={4} />
      ) : repos.isError ? (
        <ErrorState error={repos.error} onRetry={() => repos.refetch()} />
      ) : repos.data.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title="Connect a repository first"
          description="Knowledge is organised per repository."
          action={
            <Button asChild>
              <Link href={`${base}/repositories`}>Repositories</Link>
            </Button>
          }
        />
      ) : (
        repos.data.map((r) => (
          <RepoKnowledgeSection
            key={r.id}
            repoId={r.id}
            title={
              <Link
                href={`${base}/repositories/${r.id}/knowledge`}
                className="normal-case hover:text-fg"
              >
                {r.full_name}
              </Link>
            }
          />
        ))
      )}
    </PageContainer>
  );
}
