"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { MetaList } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card, CardBody, CardHeader, Mono } from "@/components/ui/misc";
import { qk } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import { applyServerErrors } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { formatDateTime } from "@/lib/utils/format";

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(64, "Name must be at most 64 characters"),
});

export function GeneralSettings() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can("workspace.manage");
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: workspace.name },
  });
  const save = useMutation({
    mutationFn: (v: z.infer<typeof schema>) => api.workspaces.update(workspace.id, v),
    onSuccess: (ws) => {
      void queryClient.invalidateQueries({ queryKey: qk.workspaces });
      form.reset({ name: ws.name });
      toast.success("Workspace updated");
    },
    onError: (e) => applyServerErrors(e, form.setError, ["name"]),
  });
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Workspace" />
        <CardBody>
          <form
            noValidate
            onSubmit={form.handleSubmit((v) => save.mutate(v))}
            className="flex flex-col gap-4"
          >
            <Field
              label="Name"
              error={form.formState.errors.name?.message}
              hint={editable ? undefined : "Only admins can rename the workspace."}
            >
              <Input disabled={!editable} {...form.register("name")} />
            </Field>
            {editable && (
              <Button
                type="submit"
                size="sm"
                className="self-start"
                loading={save.isPending}
                disabled={!form.formState.isDirty}
              >
                Save
              </Button>
            )}
          </form>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <MetaList
            items={[
              { label: "URL", value: <Mono className="text-fg">/w/{workspace.slug}</Mono> },
              { label: "Workspace ID", value: <Mono>{workspace.id}</Mono> },
              { label: "Plan", value: <span className="capitalize">{workspace.plan_key}</span> },
              { label: "Your role", value: <span className="capitalize">{workspace.role}</span> },
              { label: "Created", value: formatDateTime(workspace.created_at) },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}
