import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-fg shadow-xs hover:bg-primary-hover active:bg-primary-hover",
  secondary:
    "bg-surface text-fg border border-border shadow-xs hover:bg-surface-hover hover:border-border-strong",
  outline: "border border-border-strong text-fg hover:bg-surface-hover",
  ghost: "text-fg-muted hover:text-fg hover:bg-surface-hover",
  danger: "bg-danger text-white shadow-xs hover:brightness-95 dark:text-fg-inverse",
  link: "text-link underline-offset-4 hover:underline !px-0 !h-auto",
};

const sizes: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-xs gap-1 rounded-sm [&_svg]:size-3.5",
  sm: "h-7 px-2.5 text-sm gap-1.5 rounded-md [&_svg]:size-3.5",
  md: "h-8 px-3 text-sm gap-2 rounded-md [&_svg]:size-4",
  lg: "h-10 px-4 text-base gap-2 rounded-lg [&_svg]:size-4",
  icon: "size-8 rounded-md [&_svg]:size-4",
  "icon-sm": "size-7 rounded-md [&_svg]:size-3.5",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "secondary",
    size = "md",
    loading = false,
    asChild = false,
    disabled,
    children,
    type,
    ...props
  },
  ref,
) {
  const classes = cn(
    "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none",
    "transition-[background-color,border-color,color,box-shadow,filter] duration-100",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:shrink-0",
    variants[variant],
    sizes[size],
    className,
  );
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});
