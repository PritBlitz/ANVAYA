"use client";

import { Dialog as D, DropdownMenu as DM, Tooltip as TT } from "radix-ui";
import { X } from "lucide-react";
import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Button, type ButtonVariant } from "./button";

// ── Dialog ───────────────────────────────────────────────────────────────

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

const overlayClass =
  "fixed inset-0 z-50 bg-[hsl(340_20%_8%/0.42)] backdrop-blur-[2px] animate-fade-in";

export function DialogContent({
  title,
  description,
  children,
  className,
  size = "md",
  footer,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
} & Omit<ComponentPropsWithoutRef<typeof D.Content>, "title">) {
  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };
  return (
    <D.Portal>
      <D.Overlay className={overlayClass} />
      <D.Content
        className={cn(
          "fixed top-[12vh] left-1/2 z-50 flex max-h-[80vh] w-[calc(100vw-2rem)] -translate-x-1/2 animate-pop-in flex-col rounded-xl border border-border bg-surface-raised shadow-lg focus:outline-none",
          widths[size],
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <D.Title className="text-md font-semibold text-fg">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-sm text-fg-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">
                {typeof title === "string" ? title : "Dialog"}
              </D.Description>
            )}
          </div>
          <D.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close dialog"
              className="-mt-1 -mr-2"
            >
              <X />
            </Button>
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-5 pb-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-border bg-bg-subtle px-5 py-3">
            {footer}
          </div>
        )}
      </D.Content>
    </D.Portal>
  );
}

/** Right-hand drawer for inspecting details without leaving the current context. */
export function DrawerContent({
  title,
  description,
  children,
  className,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <D.Portal>
      <D.Overlay className={overlayClass} />
      <D.Content
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl animate-slide-in-right flex-col border-l border-border bg-surface-raised shadow-lg focus:outline-none",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <D.Title className="truncate text-base font-semibold text-fg">{title}</D.Title>
            {description ? (
              <D.Description className="mt-0.5 text-xs text-fg-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">Details</D.Description>
            )}
          </div>
          <div className="flex items-center gap-1">
            {actions}
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close panel">
                <X />
              </Button>
            </D.Close>
          </div>
        </div>
        <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

/**
 * Explicit confirmation for consequential actions (CLAUDE.md §8). The confirm button
 * shows a pending state and the dialog stays open until the server confirms.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmVariant = "primary",
  onConfirm,
  pending,
  children,
  confirmDisabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  onConfirm: () => void;
  pending?: boolean;
  children?: ReactNode;
  confirmDisabled?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        size="sm"
        title={title}
        description={description}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant={confirmVariant}
              onClick={onConfirm}
              loading={pending}
              disabled={confirmDisabled}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

// ── Dropdown menu ────────────────────────────────────────────────────────

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuGroup = DM.Group;

export function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: ComponentPropsWithoutRef<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-48 animate-pop-in overflow-hidden rounded-lg border border-border bg-surface-raised p-1 shadow-md",
          className,
        )}
        {...props}
      />
    </DM.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: ComponentPropsWithoutRef<typeof DM.Item> & { destructive?: boolean }) {
  return (
    <DM.Item
      className={cn(
        "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-surface-hover [&_svg]:size-4 [&_svg]:text-fg-muted",
        destructive ? "text-danger data-highlighted:bg-danger-soft [&_svg]:text-danger" : "text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DM.Label>) {
  return (
    <DM.Label
      className={cn(
        "px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator() {
  return <DM.Separator className="-mx-1 my-1 h-px bg-border" />;
}

// ── Tooltip ──────────────────────────────────────────────────────────────

export const TooltipProvider = TT.Provider;

export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <TT.Root>
      <TT.Trigger asChild>{children}</TT.Trigger>
      <TT.Portal>
        <TT.Content
          side={side}
          sideOffset={6}
          className="z-60 max-w-xs animate-fade-in rounded-md bg-fg px-2 py-1 text-xs text-fg-inverse shadow-md"
        >
          {content}
        </TT.Content>
      </TT.Portal>
    </TT.Root>
  );
}

/** Hook for dialogs that must close when the route is hidden by Activity. */
export function useDialogState(initial = false) {
  const [open, setOpen] = useState(initial);
  return {
    open,
    setOpen,
    onOpenChange: setOpen,
    show: () => setOpen(true),
    hide: () => setOpen(false),
  };
}
