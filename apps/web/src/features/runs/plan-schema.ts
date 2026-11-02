import { z } from "zod";
import type { EngineeringPlan } from "@/lib/api/types";

/** Text area "one item per line" ⇄ string[] */
export const linesToList = (value: string) =>
  value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
export const listToLines = (list: string[]) => list.join("\n");

const pathList = z
  .string()
  .refine(
    (v) => linesToList(v).every((p) => !p.startsWith("/") && !p.split("/").includes("..")),
    "Use repository-relative paths without '..'",
  );

/** Form shape for editing a plan (AI_WORKFLOW §4.2). */
export const planFormSchema = z.object({
  objective: z
    .string()
    .trim()
    .min(5, "Objective must be at least 5 characters")
    .max(500, "Keep the objective under 500 characters"),
  assumptions: z.string(),
  steps: z
    .array(
      z.object({
        id: z.string(),
        description: z.string().trim().min(5, "Describe the step in at least 5 characters"),
        files: pathList,
        verification: z.string(),
      }),
    )
    .min(1, "A plan needs at least one step"),
  files_to_modify: pathList.refine((v) => linesToList(v).length > 0, "List at least one file"),
  tests: z.string(),
  risks: z.string(),
  out_of_scope: z.string(),
});

export type PlanFormValues = z.infer<typeof planFormSchema>;

export function planToForm(plan: EngineeringPlan): PlanFormValues {
  return {
    objective: plan.objective,
    assumptions: listToLines(plan.assumptions),
    steps: plan.steps.map((s) => ({
      id: s.id,
      description: s.description,
      files: listToLines(s.files),
      verification: listToLines(s.verification),
    })),
    files_to_modify: listToLines(plan.files_to_modify),
    tests: listToLines(plan.tests),
    risks: listToLines(plan.risks),
    out_of_scope: listToLines(plan.out_of_scope),
  };
}

export function formToPlan(v: PlanFormValues): EngineeringPlan {
  return {
    objective: v.objective.trim(),
    assumptions: linesToList(v.assumptions),
    steps: v.steps.map((s, i) => ({
      id: s.id || `step-${i + 1}`,
      description: s.description.trim(),
      files: linesToList(s.files),
      verification: linesToList(s.verification),
    })),
    files_to_modify: linesToList(v.files_to_modify),
    tests: linesToList(v.tests),
    risks: linesToList(v.risks),
    out_of_scope: linesToList(v.out_of_scope),
  };
}

/** Files referenced by steps but not declared in files_to_modify — a scope inconsistency. */
export function undeclaredStepFiles(plan: EngineeringPlan): string[] {
  const declared = new Set(plan.files_to_modify);
  return [...new Set(plan.steps.flatMap((s) => s.files))].filter((f) => !declared.has(f));
}
