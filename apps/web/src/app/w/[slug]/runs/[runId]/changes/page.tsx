import type { Metadata } from "next";
import { ChangesView } from "@/features/runs/changes-view";

export const metadata: Metadata = { title: "Changes" };

export default function Page() {
  return <ChangesView />;
}
