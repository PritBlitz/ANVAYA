"use client";

import { useEffect } from "react";

/**
 * Marks every [data-reveal] element as in view once it scrolls into the viewport.
 * One observer for the whole page keeps the sections themselves Server Components.
 */
export function RevealObserver() {
  useEffect(() => {
    const elements = document.querySelectorAll<HTMLElement>("[data-reveal]:not([data-inview])");
    if (!("IntersectionObserver" in window)) {
      elements.forEach((el) => el.setAttribute("data-inview", "true"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-inview", "true");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  return null;
}
