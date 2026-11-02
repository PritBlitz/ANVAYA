import { RunLayout } from "@/features/runs/run-layout";

export default function Layout({ children }: LayoutProps<"/w/[slug]/runs/[runId]">) {
  return <RunLayout>{children}</RunLayout>;
}
