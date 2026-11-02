import type { Metadata } from "next";
import { TasksScreen } from "@/features/tasks/tasks-screen";

export const metadata: Metadata = { title: "Tasks" };

export default function Page() {
  return <TasksScreen />;
}
