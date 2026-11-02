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
import { qk, useRepositories } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import { isQueryable } from "@/lib/domain/status";
import { applyServerErrors } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";

export const createTaskSchema = z
  .object({
    repository_id: z.string().min(1, "Choose a repository"),
    source_type: z.enum(["manual", "github_issue", "pull_request", "failing_check"]),
    external_number: z.string().trim().optional(),
    title: z
      .string()
      .trim()
      .min(4, "Title must be at least 4 characters")
      .max(200, "Title must be at most 200 characters"),
    description: z
      .string()
      .trim()
      .min(10, "Describe the problem in at least 10 characters")
      .max(10000, "Keep the description under 10,000 characters"),
    start_now: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.source_type === "manual") return;
    const n = Number(v.external_number);
    if (!v.external_number || !Number.isInteger(n) || n < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["external_number"],
        message: "Enter the GitHub number, e.g. 214",
      });
    }
  });

export type CreateTaskValues = z.infer<typeof createTaskSchema>;

const SOURCE_LABELS = {
  manual: "Describe it manually",
  github_issue: "GitHub issue",
  pull_request: "Pull request",
  failing_check: "Failing check",
} as const;

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
      title: "",
      description: "",
      start_now: true,
    },
  });
  const source = useWatch({ control: form.control, name: "source_type" });
  const startNow = useWatch({ control: form.control, name: "start_now" });
  const errors = form.formState.errors;

  const create = useMutation({
    mutationFn: async (v: CreateTaskValues) => {
      const task = await api.repositories.createTask(
        v.repository_id,
        {
          source_type: v.source_type,
          title: v.title,
          description: v.description,
          ...(v.source_type !== "manual" ? { external_number: Number(v.external_number) } : {}),
        },
        key.current,
      );
      if (!v.start_now) return { task, run: null };
      const repo = queryable.find((r) => r.id === v.repository_id);
      const run = await api.tasks.startRun(
        task.id,
        { mode: "local", base_branch: repo?.default_branch ?? "main" },
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
          {source !== "manual" && (
            <Field
              label={
                source === "failing_check" ? "Check run number" : `${SOURCE_LABELS[source]} number`
              }
              required
              error={errors.external_number?.message}
              hint="Its title, body, and comments are imported as untrusted context."
            >
              <Input
                inputMode="numeric"
                placeholder="214"
                className="w-40 font-mono"
                {...form.register("external_number")}
              />
            </Field>
          )}
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
