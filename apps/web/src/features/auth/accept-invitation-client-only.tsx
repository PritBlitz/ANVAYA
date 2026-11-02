"use client";

import dynamic from "next/dynamic";

/** Reads the token from the URL fragment, which only exists in the browser. */
export const AcceptInvitationClientOnly = dynamic(
  () => import("./accept-invitation").then((m) => m.AcceptInvitation),
  {
    ssr: false,
  },
);
