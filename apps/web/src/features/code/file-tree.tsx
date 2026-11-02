"use client";

import { ChevronRight, File, FileX2, Folder, FolderOpen } from "lucide-react";
import { Fragment, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TreeEntry } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

interface VisibleNode {
  entry: TreeEntry;
  depth: number;
  parent: string | null;
}

function ancestorsOf(path: string | null): string[] {
  if (!path) return [];
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

function flatten(
  entries: TreeEntry[],
  expanded: Set<string>,
  depth = 0,
  parent: string | null = null,
): VisibleNode[] {
  const out: VisibleNode[] = [];
  for (const entry of entries) {
    out.push({ entry, depth, parent });
    if (entry.type === "directory" && expanded.has(entry.path) && entry.children) {
      out.push(...flatten(entry.children, expanded, depth + 1, entry.path));
    }
  }
  return out;
}

/**
 * WAI-ARIA tree view: arrow keys move, Right/Left expand/collapse or move to
 * child/parent, Enter/Space opens a file, Home/End jump. Roving tabindex.
 */
export function FileTree({
  entries,
  selectedPath,
  onSelect,
  label = "Repository files",
  onExpand,
}: {
  entries: TreeEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  label?: string;
  /** Called when a directory opens, so its level can be loaded lazily. */
  onExpand?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ancestorsOf(selectedPath)));
  const [focused, setFocused] = useState<string | null>(selectedPath ?? entries[0]?.path ?? null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const visible = useMemo(() => flatten(entries, expanded), [entries, expanded]);

  const focusPath = (path: string) => {
    setFocused(path);
    refs.current.get(path)?.focus();
  };

  const toggle = (path: string, open?: boolean) => {
    const shouldOpen = open ?? !expanded.has(path);
    if (shouldOpen) onExpand?.(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (shouldOpen) next.add(path);
      else next.delete(path);
      return next;
    });
  };
  const loading = visible.some(
    (n) => n.entry.type === "directory" && expanded.has(n.entry.path) && !n.entry.children,
  );

  const activate = (entry: TreeEntry) => {
    if (entry.type === "directory") toggle(entry.path);
    else if (!entry.is_excluded) onSelect(entry.path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, node: VisibleNode, index: number) => {
    const { entry } = node;
    const isDir = entry.type === "directory";
    const open = expanded.has(entry.path);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (visible[index + 1]) focusPath(visible[index + 1]!.entry.path);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (visible[index - 1]) focusPath(visible[index - 1]!.entry.path);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (isDir && !open) toggle(entry.path, true);
        else if (isDir && open && entry.children?.[0]) focusPath(entry.children[0].path);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (isDir && open) toggle(entry.path, false);
        else if (node.parent) focusPath(node.parent);
        break;
      case "Home":
        e.preventDefault();
        if (visible[0]) focusPath(visible[0].entry.path);
        break;
      case "End":
        e.preventDefault();
        if (visible.length) focusPath(visible[visible.length - 1]!.entry.path);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        activate(entry);
        break;
    }
  };

  const tabStop = visible.some((n) => n.entry.path === focused) ? focused : visible[0]?.entry.path;

  return (
    <div
      role="tree"
      aria-label={label}
      aria-busy={loading || undefined}
      className="flex flex-col py-1 text-sm"
    >
      {visible.map((node, index) => {
        const { entry, depth } = node;
        const isDir = entry.type === "directory";
        const open = expanded.has(entry.path);
        const selected = entry.path === selectedPath;
        return (
          <Fragment key={entry.path}>
            <div
              ref={(el) => {
                if (el) refs.current.set(entry.path, el);
                else refs.current.delete(entry.path);
              }}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={isDir ? open : undefined}
              aria-selected={selected}
              aria-disabled={entry.is_excluded || undefined}
              tabIndex={entry.path === tabStop ? 0 : -1}
              onFocus={() => setFocused(entry.path)}
              onClick={() => activate(entry)}
              onKeyDown={(e) => onKeyDown(e, node, index)}
              title={
                entry.is_excluded
                  ? `Excluded from indexing: ${entry.exclusion_reason?.replace(/_/g, " ")}`
                  : entry.path
              }
              style={{ paddingLeft: 8 + depth * 14 }}
              className={cn(
                "flex h-7 cursor-default items-center gap-1.5 rounded-md pr-2 outline-none select-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                selected
                  ? "bg-surface-selected font-medium text-fg"
                  : "text-fg-muted hover:bg-surface-hover hover:text-fg",
                entry.is_excluded && "text-fg-subtle line-through decoration-fg-subtle/50",
              )}
            >
              {isDir ? (
                <>
                  <ChevronRight
                    aria-hidden
                    className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
                  />
                  {open ? (
                    <FolderOpen aria-hidden className="size-4 shrink-0 text-accent-fg" />
                  ) : (
                    <Folder aria-hidden className="size-4 shrink-0 text-accent-fg" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3.5 shrink-0" />
                  {entry.is_excluded ? (
                    <FileX2 aria-hidden className="size-4 shrink-0" />
                  ) : (
                    <File aria-hidden className="size-4 shrink-0" />
                  )}
                </>
              )}
              <span className="truncate">{entry.name}</span>
            </div>
            {isDir && open && !entry.children && (
              <div
                aria-hidden
                style={{ paddingLeft: 8 + (depth + 1) * 14 + 20 }}
                className="flex h-7 items-center text-xs text-fg-subtle"
              >
                Loading…
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
