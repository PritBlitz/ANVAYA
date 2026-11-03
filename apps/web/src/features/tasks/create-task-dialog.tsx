"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/overlays";
import { createIdempotencyKey } from "@/lib/api/client";
import { qk, useFailingChecks, useRepositories } from "@/lib/api/queries";
import { Badge } from "@/components/ui/badge";
import { SkeletonRows } from "@/components/ui/misc";
import { describeError } from "@/lib/api/errors";
import { CREATABLE_TASK_SOURCES, type CreateTaskRequest } from "@/lib/api/types";
import { api } from "@/lib/api/runtime";
import { isQueryable } from "@/lib/domain/status";
import { applyServerErrors } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";

/**
 * Manual tasks carry a title and description. GitHub-sourced tasks send only a reference
 * (issue or PR number, or a check run id): the server imports the title, body and
 * metadata as untrusted context.
 */
export const createTaskSchema = z
  .object({
    repository_id: z.string().min(1, "Choose a repository"),
    source_type: z.enum(CREATABLE_TASK_SOURCES),
    external_number: z.string().trim().optional(),
    check_run_id: z.string().trim().optional(),
    include_review_comments: z.boolean().optional(),
    title: z.string().trim().max(200, "Title must be at most 200 characters"),
    description: z.string().trim().max(10000, "Keep the description under 10,000 characters"),
    start_now: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const positive = (raw: string | undefined) => {
      const n = Number(raw);
      return Boolean(raw) && Number.isSafeInteger(n) && n >= 1;
    };
    if (v.source_type === "github_issue" || v.source_type === "pull_request") {
      if (!positive(v.external_number)) {
        ctx.addIssue({
          code: "custom",
          path: ["external_number"],
          message:
            v.source_type === "github_issue"
              ? "Enter the issue number, e.g. 214"
              : "Enter the pull request number, e.g. 87",
        });
      }
      return;
    }
    if (v.source_type === "failing_check") {
      if (!positive(v.check_run_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["check_run_id"],
          message: "Pick a failing check or enter its check run id",
        });
      }
      return;
    }
    if (v.title.length < 4)
      ctx.addIssue({
        code: "custom",
        path: ["title"],
        message: "Title must be at least 4 characters",
      });
    if (v.description.length < 10) {
      ctx.addIssue({
        code: "custom",
        path: ["description"],
        message: "Describe the problem in at least 10 characters",
      });
    }
  });

export type CreateTaskValues = z.infer<typeof createTaskSchema>;

/** Request body for the selected source (strict: no fields the server would reject). */
export function toCreateTaskRequest(v: CreateTaskValues): CreateTaskRequest {
  switch (v.source_type) {
    case "github_issue":
      return { source_type: "github_issue", external_number: Number(v.external_number) };
    case "pull_request":
      return {
        source_type: "pull_request",
        external_number: Number(v.external_number),
        include_review_comments: Boolean(v.include_review_comments),
      };
    case "failing_check":
      return { source_type: "failing_check", check_run_id: Number(v.check_run_id) };
    default:
      return { source_type: "manual", title: v.title, description: v.description };
  }
}

const SOURCE_LABELS: Record<CreateTaskValues["source_type"], string> = {
  manual: "Describe it manually",
  github_issue: "GitHub issue",
  pull_request: "GitHub pull request",
  failing_check: "Failing CI check",
};

/** Lists recent failing checks on the default branch; choosing one fills the check run id. */
function FailingCheckPicker({
  repositoryId,
  value,
  onPick,
}: {
  repositoryId: string;
  value: string | undefined;
  onPick: (id: string) => void;
}) {
  const checks = useFailingChecks(repositoryId || undefined);
  if (!repositoryId) {
    return <p className="text-xs text-fg-muted">Choose a repository to list its failing checks.</p>;
  }
  if (checks.isPending) return <SkeletonRows rows={2} />;
  if (checks.isError) {
    return (
      <p className="text-xs text-fg-muted" role="status">
        Couldn&apos;t list failing checks ({describeError(checks.error).title.toLowerCase()}). Enter
        a check run id instead.
      </p>
    );
  }
  if (checks.data.check_runs.length === 0) {
    return (
      <p className="text-xs text-fg-muted" role="status">
        No failing checks on <span className="font-mono">{checks.data.ref}</span>. Enter a check run
        id from another branch instead.
      </p>
    );
  }
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs text-fg-muted">
        Failing on <span className="font-mono">{checks.data.ref}</span>
      </legend>
      {checks.data.check_runs.map((c) => (
        <label
          key={c.id}
          className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-hover"
        >
          <input
            type="radio"
            name="failing-check"
            className="size-4 accent-(--primary)"
            checked={value === String(c.id)}
            onChange={() => onPick(String(c.id))}
          />
          <span className="min-w-0 flex-1 truncate">{c.name}</span>
          <Badge tone="danger">{c.conclusion.replace(/_/g, " ")}</Badge>
          <span className="font-mono text-xs text-fg-subtle">{c.head_sha.slice(0, 7)}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  defaultRepositoryId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultRepositoryId?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { base, workspaceId } = useWorkspace();
  const repos = useRepositories();
  const key = useRef(createIdempotencyKey());
  const queryable = (repos.data ?? []).filter((r) => isQueryable(r.indexing_status));

  const form = useForm<CreateTaskValues>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: {
      repository_id: defaultRepositoryId ?? "",
      source_type: "manual",
      external_number: "",
      check_run_id: "",
      include_review_comments: false,
      title: "",
      description: "",
      start_now: true,
    },
  });
  const source = useWatch({ control: form.control, name: "source_type" });
  const repositoryId = useWatch({ control: form.control, name: "repository_id" });
  const checkRunId = useWatch({ control: form.control, name: "check_run_id" });
  const startNow = useWatch({ control: form.control, name: "start_now" });
  const errors = form.formState.errors;

  const create = useMutation({
    mutationFn: async (v: CreateTaskValues) => {
      const task = await api.repositories.createTask(
        v.repository_id,
        toCreateTaskRequest(v),
        key.current,
      );
      if (!v.start_now) return { task, run: null };
      const repo = queryable.find((r) => r.id === v.repository_id);
      // Mode omitted: the server applies the workspace's default mode (local-first).
      const run = await api.tasks.startRun(
        task.id,
        { base_branch: repo?.default_branch ?? "main" },
        `start-${task.id}-1`,
      );
      return { task, run };
    },
    onSuccess: ({ task, run }) => {
      key.current = createIdempotencyKey();
      void queryClient.invalidateQueries({ queryKey: qk.tasks(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: qk.runs(workspaceId) });
      form.reset();
      onOpenChange(false);
      if (run) {
        toast.success("Investigation started", {
          description: "No code changes happen until you approve a plan.",
        });
        // replace (not push): the "?new=1" entry must not survive in history, or Back
        // would reopen the dialog (Activity preserves the hidden route).
        router.replace(`${base}/runs/${run.id}`);
      } else {
        toast.success("Task created");
        router.replace(`${base}/tasks/${task.id}`);
      }
    },
    onError: (e) => {
      key.current = createIdempotencyKey();
      applyServerErrors(e, form.setError, [
        "title",
        "description",
        "repository_id",
        "external_number",
        "check_run_id",
        "source_type",
      ]);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent
        size="lg"
        title="New engineering task"
        description="Describe the problem. Anvaya investigates and proposes a plan; nothing changes until you approve it."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost" disabled={create.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" form="create-task" variant="primary" loading={create.isPending}>
              {startNow ? "Create and investigate" : "Create task"}
            </Button>
          </>
        }
      >
        <form
          id="create-task"
          noValidate
          onSubmit={form.handleSubmit((v) => create.mutate(v))}
          className="flex flex-col gap-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Repository"
              required
              error={errors.repository_id?.message}
              hint={
                queryable.length < (repos.data?.length ?? 0)
                  ? "Only indexed repositories are listed."
                  : undefined
              }
            >
              <Select {...form.register("repository_id")}>
                <option value="">Select a repository…</option>
                {queryable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.full_name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Source" error={errors.source_type?.message}>
              <Select {...form.register("source_type")}>
                {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {source === "github_issue" && (
            <Field
              label="Issue number"
              required
              error={errors.external_number?.message}
              hint="Anvaya imports the issue's title and body as untrusted context."
            >
              <Input
                inputMode="numeric"
                placeholder="214"
                className="w-40 font-mono"
                {...form.register("external_number")}
              />
            </Field>
          )}
          {source === "pull_request" && (
            <>
              <Field
                label="Pull request number"
                required
                error={errors.external_number?.message}
                hint="Anvaya imports the title, body, branches and changed-file list as untrusted context."
              >
                <Input
                  inputMode="numeric"
                  placeholder="87"
                  className="w-40 font-mono"
                  {...form.register("external_number")}
                />
              </Field>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-(--primary)"
                  {...form.register("include_review_comments")}
                />
                <span>
                  <span className="text-fg">Include review comments</span>
                  <span className="block text-xs text-fg-muted">
                    The first review comments are imported too, also as untrusted context.
                  </span>
                </span>
              </label>
            </>
          )}
          {source === "failing_check" && (
            <>
              <FailingCheckPicker
                repositoryId={repositoryId}
                value={checkRunId}
                onPick={(id) =>
                  form.setValue("check_run_id", id, { shouldValidate: form.formState.isSubmitted })
                }
              />
              <Field
                label="Check run id"
                required
                error={errors.check_run_id?.message}
                hint="The check's name, conclusion and a redacted excerpt of its output are imported as untrusted evidence."
              >
                <Input
                  inputMode="numeric"
                  placeholder="31000000001"
                  className="w-56 font-mono"
                  {...form.register("check_run_id")}
                />
              </Field>
            </>
          )}
          {source === "manual" && (
            <>
              <Field label="Title" required error={errors.title?.message}>
                <Input
                  placeholder="Concurrent refresh requests sign users out"
                  {...form.register("title")}
                />
              </Field>
              <Field
                label="Description"
                required
                error={errors.description?.message}
                hint="Expected vs. actual behaviour, constraints, and anything out of scope."
              >
                <Textarea rows={6} {...form.register("description")} />
              </Field>
            </>
          )}
          <label className="flex items-start gap-2.5 rounded-md border border-border bg-bg-subtle p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-(--primary)"
              {...form.register("start_now")}
            />
            <span>
              <span className="font-medium text-fg">Start investigation now</span>
              <span className="block text-xs text-fg-muted">
                Runs locally with your workspace&apos;s default budgets. You can change mode and
                budgets from the task page instead.
              </span>
            </span>
          </label>
        </form>
      </DialogContent>
    </Dialog>
  );
}
