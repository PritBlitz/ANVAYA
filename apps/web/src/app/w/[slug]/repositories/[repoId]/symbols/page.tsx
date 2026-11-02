import type { Metadata } from "next";
import { SymbolsScreen } from "@/features/code-intel/symbols-screen";

export const metadata: Metadata = { title: "Symbols" };

export default function Page() {
  return <SymbolsScreen />;
}
