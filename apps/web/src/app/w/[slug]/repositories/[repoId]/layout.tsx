import { RepoLayout } from "@/features/repositories/repo-layout";

export default function Layout({ children }: LayoutProps<"/w/[slug]/repositories/[repoId]">) {
  return <RepoLayout>{children}</RepoLayout>;
}
