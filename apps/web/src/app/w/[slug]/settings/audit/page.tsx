import type { Metadata } from "next";
import { AuditSettings } from "@/features/settings/audit-settings";

export const metadata: Metadata = { title: "Audit log" };

export default function Page() {
  return <AuditSettings />;
}
