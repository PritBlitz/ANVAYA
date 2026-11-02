"use client";

import dynamic from "next/dynamic";

/**
 * The callback validates `state` against sessionStorage, which only exists in the
 * browser; rendering it on the server would produce mismatched HTML.
 */
export const GitHubCallbackClientOnly = dynamic(
  () => import("./github-callback").then((m) => m.GitHubCallback),
  {
    ssr: false,
  },
);
