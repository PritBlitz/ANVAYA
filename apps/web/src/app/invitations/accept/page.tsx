import type { Metadata } from "next";
import { AcceptInvitationClientOnly } from "@/features/auth/accept-invitation-client-only";

export const metadata: Metadata = { title: "Accept invitation" };

export default function Page() {
  return <AcceptInvitationClientOnly />;
}
