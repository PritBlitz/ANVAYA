import type { Metadata } from "next";
import { IntegrationsSettings } from "@/features/settings/integrations-settings";

export const metadata: Metadata = { title: "Integrations" };

export default function Page() {
  return <IntegrationsSettings />;
}
