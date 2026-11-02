"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, UserMinus } from "lucide-react";
import { useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Avatar, Card, CardHeader, SkeletonRows } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogClose, DialogContent } from "@/components/ui/overlays";
import { ErrorState } from "@/components/ui/states";
import { createIdempotencyKey } from "@/lib/api/client";
import { qk, useInvitations, useMe, useMembers } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import { WORKSPACE_ROLES, type Invitation, type Member, type WorkspaceRole } from "@/lib/api/types";
import { ROLE_DESCRIPTIONS } from "@/lib/domain/permissions";
import { applyServerErrors, notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { formatRelative } from "@/lib/utils/format";
import { CopyButton } from "@/features/code/code-view";

export const inviteSchema = z.object({
  email: z.email("Enter a valid email address").max(254),
  role: z.enum(["admin", "member", "viewer"]),
});
type InviteValues = z.infer<typeof inviteSchema>;

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const key = useRef(createIdempotencyKey());
  const [created, setCreated] = useState<Invitation | null>(null);
  const form = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "member" },
  });
  const role = useWatch({ control: form.control, name: "role" });
  const invite = useMutation({
    mutationFn: (v: InviteValues) => api.workspaces.invite(workspaceId, v, key.current),
    onSuccess: (inv) => {
      key.current = createIdempotencyKey();
      void queryClient.invalidateQueries({ queryKey: qk.invitations(workspaceId) });
      form.reset();
      // The API returns the accept link once (no email delivery yet): show it to share.
      if (inv.accept_url) setCreated(inv);
      else {
        toast.success(`Invitation created for ${inv.email}`);
        onOpenChange(false);
      }
    },
    onError: (e) => {
      key.current = createIdempotencyKey();
      applyServerErrors(e, form.setError, ["email", "role"]);
    },
  });
  const close = (o: boolean) => {
    if (!o) setCreated(null);
    onOpenChange(o);
  };
  if (created) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent
          title="Share the invitation link"
          description={`Anvaya doesn't send email yet. Send this link to ${created.email}; it works once and expires${created.expires_at ? ` on ${created.expires_at.slice(0, 10)}` : ""}.`}
          footer={
            <Button variant="primary" onClick={() => close(false)}>
              Done
            </Button>
          }
        >
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
              {created.accept_url}
            </code>
            <CopyButton value={created.accept_url ?? ""} label="Copy link" />
          </div>
          <p className="mt-3 text-xs text-fg-muted">
            This is the only time the link is shown. If it&apos;s lost, revoke the invitation and
            create a new one.
          </p>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title="Invite a member"
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" form="invite-form" variant="primary" loading={invite.isPending}>
              Create invitation
            </Button>
          </>
        }
      >
        <form
          id="invite-form"
          noValidate
          onSubmit={form.handleSubmit((v) => invite.mutate(v))}
          className="flex flex-col gap-4"
        >
          <Field label="Email" required error={form.formState.errors.email?.message}>
            <Input
              type="email"
              autoComplete="off"
              placeholder="teammate@company.com"
              {...form.register("email")}
            />
          </Field>
          <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
            <Select {...form.register("role")}>
              <option value="viewer">Viewer</option>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  member,
  editable,
  isSelf,
  isOwner,
}: {
  member: Member;
  editable: boolean;
  isSelf: boolean;
  isOwner: boolean;
}) {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const name = member.user.display_name ?? member.user.email;
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.members(workspaceId) });
  const changeRole = useMutation({
    mutationFn: (role: WorkspaceRole) =>
      api.workspaces.changeRole(workspaceId, member.user.id, role),
    onSuccess: (m) => {
      toast.success(`${name} is now ${m.role === "admin" ? "an" : "a"} ${m.role}`);
      void refresh();
    },
    onError: (e) => {
      notifyError(e, "Role not changed");
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.workspaces.removeMember(workspaceId, member.user.id),
    onSuccess: () => {
      toast.success(`${name} removed`);
      setRemoving(false);
      void refresh();
    },
    onError: (e) => notifyError(e),
  });
  const canEditThis = editable && !isSelf && (member.role !== "owner" || isOwner);
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Avatar name={name} src={member.user.avatar_url} size={28} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">
          {name} {isSelf && <Badge className="ml-1">You</Badge>}
        </p>
        <p className="truncate text-xs text-fg-muted">
          {member.user.email} · joined {formatRelative(member.created_at)}
        </p>
      </div>
      {canEditThis ? (
        <>
          <Select
            aria-label={`Role for ${name}`}
            value={member.role}
            onChange={(e) => changeRole.mutate(e.target.value as WorkspaceRole)}
            disabled={changeRole.isPending}
            className="w-32"
          >
            {WORKSPACE_ROLES.filter((r) => r !== "owner" || isOwner).map((r) => (
              <option key={r} value={r}>
                {r[0]!.toUpperCase() + r.slice(1)}
              </option>
            ))}
          </Select>
          {member.role !== "owner" && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${name}`}
              onClick={() => setRemoving(true)}
            >
              <UserMinus />
            </Button>
          )}
        </>
      ) : (
        <Badge size="md" className="capitalize">
          {member.role}
        </Badge>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${name}?`}
        description="They lose access to this workspace immediately. Their past approvals stay in the audit trail."
        confirmLabel="Remove member"
        confirmVariant="danger"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </li>
  );
}

export function MembersSettings() {
  const { can } = useWorkspace();
  return (
    <div className="flex flex-col gap-6">
      <MembersCard />
      {can("members.manage") && <PendingInvitations />}
    </div>
  );
}

function MembersCard() {
  const { can, workspace } = useWorkspace();
  const me = useMe();
  const members = useMembers();
  const [inviting, setInviting] = useState(false);
  const editable = can("members.manage");
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Members"
        description="Roles are enforced by the server on every request."
        actions={
          editable && (
            <Button size="sm" variant="primary" onClick={() => setInviting(true)}>
              <UserPlus /> Invite
            </Button>
          )
        }
      />
      {members.isPending ? (
        <SkeletonRows rows={3} className="p-4" />
      ) : members.isError ? (
        <ErrorState compact error={members.error} onRetry={() => members.refetch()} />
      ) : (
        <ul className="divide-y divide-border">
          {members.data.map((m) => (
            <MemberRow
              key={m.user.id}
              member={m}
              editable={editable}
              isSelf={m.user.id === me.data?.user.id}
              isOwner={workspace.role === "owner"}
            />
          ))}
        </ul>
      )}
      <InviteDialog open={inviting} onOpenChange={setInviting} />
    </Card>
  );
}

function PendingInvitations() {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const invitations = useInvitations();
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api.workspaces.revokeInvitation(workspaceId, id),
    onSuccess: () => {
      toast.success("Invitation revoked");
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: qk.invitations(workspaceId) });
    },
    onError: (e) => notifyError(e),
  });
  const pending = (invitations.data ?? []).filter((i) => i.status === "pending");
  if (invitations.isPending || pending.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Pending invitations" description="Links that haven't been accepted yet." />
      <ul className="divide-y divide-border">
        {pending.map((i) => (
          <li key={i.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-fg">{i.email}</p>
              <p className="text-xs text-fg-muted">
                {i.role} · invited {formatRelative(i.created_at)}
                {i.expires_at ? ` · expires ${i.expires_at.slice(0, 10)}` : ""}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={() => setRevoking(i)}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke the invitation for ${revoking?.email ?? ""}?`}
        description="The link stops working immediately."
        confirmLabel="Revoke invitation"
        confirmVariant="danger"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </Card>
  );
}
