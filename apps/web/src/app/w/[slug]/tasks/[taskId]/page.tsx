import type { Metadata } from "next";
import { TaskDetailScreen } from "@/features/tasks/task-detail";

export const metadata: Metadata = { title: "Task" };

export default function Page() {
  return <TaskDetailScreen />;
}
