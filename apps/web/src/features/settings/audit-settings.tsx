"use client";

import { Lock, ScrollText } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Card, Mono, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAuditEvents, useMembers } from "@/lib/api/queries";
import type { AuditListParams } from "@/lib/api/types";
import { useWorkspace } from "@/lib/workspace/context";
import { formatDateTime } from "@/lib/utils/format";

export function AuditSettings() {
  const { can } = useWorkspace();
  const [action, setAction] = useState("");
  const [actorUserId, setActorUserId] = useState("");
  const members = useMembers();
  const params: Omit<AuditListParams, "cursor"> = {
    action: useDeferredValue(action.trim()) || undefined,
    actor_user_id: actorUserId || undefined,
  };
  const events = useAuditEvents(params, can("audit.view"));

  if (!can("audit.view")) {
    return (
      <EmptyState
        icon={<Lock />}
        title="Admins only"
        description="The audit log is visible to workspace owners and admins."
      />
    );
  }
  const items = events.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="Filter by action"
          placeholder="Action, e.g. plan. or repository."
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="font-mono text-xs"
        />
        <Select
          aria-label="Filter by actor"
          value={actorUserId}
          onChange={(e) => setActorUserId(e.target.value)}
        >
          <option value="">All actors</option>
          {members.data?.map((m) => (
            <option key={m.user.id} value={m.user.id}>
              {m.user.display_name ?? m.user.email}
            </option>
          ))}
        </Select>
      </div>
      <Card className="overflow-hidden">
        {events.isPending ? (
          <SkeletonRows rows={6} className="p-4" />
        ) : events.isError ? (
          <ErrorState compact error={events.error} onRetry={() => events.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState compact icon={<ScrollText />} title="No matching events" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Audit events</caption>
              <thead className="border-b border-border bg-bg-subtle text-left text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Time (UTC)
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Actor
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Action
                  </th>
                  <th scope="col" className="hidden px-4 py-2 font-medium md:table-cell">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap text-fg-muted">
                      {formatDateTime(e.created_at).replace(" UTC", "")}
                    </td>
                    <td className="px-4 py-2.5 text-fg">
                      {e.actor_display ?? <span className="capitalize">{e.actor_type}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <Mono className="text-fg">{e.action}</Mono>
                      {e.resource_type && <Badge className="ml-2">{e.resource_type}</Badge>}
                    </td>
                    <td className="hidden max-w-xs px-4 py-2.5 md:table-cell">
                      <span
                        className="block truncate font-mono text-2xs text-fg-subtle"
                        title={JSON.stringify(e.metadata_redacted)}
                      >
                        {Object.keys(e.metadata_redacted).length
                          ? JSON.stringify(e.metadata_redacted)
                          : "—"}
                      </span>
                      {e.request_id && (
                        <span className="block font-mono text-2xs text-fg-subtle">
                          {e.request_id}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {events.hasNextPage && (
        <Button
          className="self-center"
          onClick={() => events.fetchNextPage()}
          loading={events.isFetchingNextPage}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
