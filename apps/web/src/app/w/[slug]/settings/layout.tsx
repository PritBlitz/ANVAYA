import { SettingsLayout } from "@/features/settings/settings-layout";

export default function Layout({ children }: LayoutProps<"/w/[slug]/settings">) {
  return <SettingsLayout>{children}</SettingsLayout>;
}
