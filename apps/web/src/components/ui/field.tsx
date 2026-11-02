import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface ControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

interface FieldProps {
  label: ReactNode;
  /** A single control element, or a render function for composite controls. */
  children: ReactElement<Record<string, unknown>> | ((control: ControlProps) => ReactNode);
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  /** Visually hide the label but keep it for assistive technology. */
  hideLabel?: boolean;
}

/** Wires label, hint and error to its control with id, aria-describedby and aria-invalid. */
export function Field({
  label,
  children,
  hint,
  error,
  required,
  className,
  hideLabel,
}: FieldProps) {
  const autoId = useId();
  const childId =
    typeof children !== "function" && isValidElement(children)
      ? (children.props.id as string | undefined)
      : undefined;
  const id = childId ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const control: ControlProps = {
    id,
    "aria-describedby": [hintId, errorId].filter(Boolean).join(" ") || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-required": required || undefined,
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cn("text-sm font-medium text-fg", hideLabel && "sr-only")}>
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-danger">
            *
          </span>
        )}
      </label>
      {typeof children === "function" ? children(control) : cloneElement(children, { ...control })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
