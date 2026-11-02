import type { Metadata } from "next";
import { GeneralSettings } from "@/features/settings/general-settings";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <GeneralSettings />;
}
