"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createIdempotencyKey } from "@/lib/api/client";
import { qk } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import { applyServerErrors } from "@/lib/forms";
import { slugify } from "@/lib/utils/format";

export const createWorkspaceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(64, "Name must be at most 64 characters"),
  slug: z
    .string()
    .trim()
    .min(2, "URL must be at least 2 characters")
    .max(40, "URL must be at most 40 characters")
    .regex(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      "Use lowercase letters, numbers, and single hyphens",
    ),
});

export type CreateWorkspaceValues = z.infer<typeof createWorkspaceSchema>;

export function CreateWorkspaceForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const idempotencyKey = useRef(createIdempotencyKey());
  const form = useForm<CreateWorkspaceValues>({
    resolver: zodResolver(createWorkspaceSchema),
    defaultValues: { name: "", slug: "" },
  });

  const mutation = useMutation({
    mutationFn: (values: CreateWorkspaceValues) =>
      api.workspaces.create(values, idempotencyKey.current),
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: qk.workspaces });
      router.push(`/w/${workspace.slug}/repositories/connect?onboarding=1`);
    },
    onError: (error) => {
      // A rejected request may be retried with corrected input: issue a fresh key.
      idempotencyKey.current = createIdempotencyKey();
      applyServerErrors(error, form.setError, ["name", "slug"]);
    },
  });

  const nameField = form.register("name", {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      // Keep the URL in sync with the name until the user edits the URL themselves.
      if (!form.getFieldState("slug").isDirty)
        form.setValue("slug", slugify(e.target.value), {
          shouldValidate: form.formState.isSubmitted,
        });
    },
  });
  const slugField = form.register("slug");

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
      className="flex flex-col gap-5"
    >
      <Field label="Workspace name" error={form.formState.errors.name?.message} required>
        <Input
          autoFocus
          autoComplete="organization"
          placeholder="Acme Engineering"
          {...nameField}
        />
      </Field>
      <Field
        label="Workspace URL"
        hint="Used in links. Lowercase letters, numbers and hyphens."
        error={form.formState.errors.slug?.message}
        required
      >
        {(control) => (
          <div className="flex items-center rounded-md shadow-xs">
            <span
              aria-hidden
              className="flex h-8 items-center rounded-l-md border border-r-0 border-border bg-surface-sunken px-2.5 font-mono text-xs text-fg-muted"
            >
              anvaya/w/
            </span>
            <Input
              {...control}
              className="rounded-l-none font-mono shadow-none"
              spellCheck={false}
              {...slugField}
            />
          </div>
        )}
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={mutation.isPending}>
        Create workspace
      </Button>
    </form>
  );
}
