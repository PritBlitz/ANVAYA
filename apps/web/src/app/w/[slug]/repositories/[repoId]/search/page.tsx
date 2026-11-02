import type { Metadata } from "next";
import { SearchScreen } from "@/features/search/search-screen";

export const metadata: Metadata = { title: "Search" };

export default function Page() {
  return <SearchScreen />;
}
