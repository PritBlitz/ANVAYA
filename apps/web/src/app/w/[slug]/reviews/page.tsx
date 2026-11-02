import type { Metadata } from "next";
import { ReviewsScreen } from "@/features/runs/runs-screen";

export const metadata: Metadata = { title: "Reviews" };

export default function Page() {
  return <ReviewsScreen />;
}
