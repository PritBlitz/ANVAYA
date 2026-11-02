import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { toast } from "sonner";
import { describeError, isApiError } from "@/lib/api/errors";

/**
 * Map a server validation error (422/409 with details.fields) onto form fields.
 * Anything not attributable to a field becomes a toast. Returns true if handled
 * at field level.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
): boolean {
  if (isApiError(error)) {
    const fieldErrors = error.fieldErrors;
    let applied = false;
    for (const [key, message] of Object.entries(fieldErrors)) {
      if ((fields as readonly string[]).includes(key)) {
        setError(key as Path<T>, { type: "server", message });
        applied = true;
      }
    }
    if (applied) return true;
  }
  notifyError(error);
  return false;
}

export function notifyError(error: unknown, fallbackTitle?: string) {
  const { title, description, requestId } = describeError(error);
  toast.error(fallbackTitle ?? title, {
    description: requestId ? `${description} (Request ${requestId})` : description,
  });
}
