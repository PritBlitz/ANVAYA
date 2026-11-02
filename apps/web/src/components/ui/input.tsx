import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export const controlStyles =
  "w-full rounded-md border border-border bg-surface text-sm text-fg shadow-xs transition-[border-color,box-shadow] placeholder:text-fg-subtle " +
  "hover:border-border-strong focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-muted " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger/25";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = "text", ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(controlStyles, "h-8 px-2.5", className)}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 4, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(controlStyles, "min-h-16 resize-y px-2.5 py-2 leading-relaxed", className)}
      {...props}
    />
  );
});

/** Native select: fully keyboard and screen-reader accessible on every platform. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(controlStyles, "h-8 appearance-none pr-8 pl-2.5", className)}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-fg-muted"
        />
      </div>
    );
  },
);
