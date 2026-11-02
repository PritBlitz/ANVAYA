import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isApiError } from "./errors";

export const MAX_QUERY_RETRIES = 2;

/**
 * Retry only transient failures (network, 429, 502–504) for reads.
 * 4xx responses are deterministic — retrying them only delays feedback.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  if (!isApiError(error)) return false;
  return error.isTransient;
}

export function retryDelay(attempt: number, error: unknown): number {
  if (isApiError(error) && error.isRateLimited) {
    const after = Number(error.details.retry_after_seconds);
    if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

export function createQueryClient(onUnauthenticated?: () => void) {
  const handle = (error: unknown) => {
    if (isApiError(error) && error.isUnauthenticated) onUnauthenticated?.();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: handle }),
    mutationCache: new MutationCache({ onError: handle }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: shouldRetryQuery,
        retryDelay,
        refetchOnWindowFocus: true,
      },
      mutations: {
        // Mutations are never retried automatically: side effects need explicit intent
        // and are de-duplicated server-side with Idempotency-Key.
        retry: false,
      },
    },
  });
}
