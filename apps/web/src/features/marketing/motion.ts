import type { CSSProperties } from "react";

/**
 * Inline animation helper for marketing scenes. Pair with className="mk-anim" so the
 * prefers-reduced-motion rule in globals.css can switch every animation off.
 */
export function anim(
  name: string,
  { delay = 0, duration = 600, iteration = "1", easing = "var(--ease-out-quint)" } = {},
): CSSProperties {
  return {
    animationName: name,
    animationDuration: `${duration}ms`,
    animationDelay: `${delay}ms`,
    animationIterationCount: iteration,
    animationTimingFunction: easing,
    animationFillMode: "both",
  };
}

/** Stagger delay for scroll reveals (consumed by the [data-reveal] transition). */
export function revealDelay(ms: number): CSSProperties {
  return { ["--reveal-delay" as string]: `${ms}ms` } as CSSProperties;
}
