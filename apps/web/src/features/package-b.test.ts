import { describe, expect, it } from "vitest";
import { toTestSelection } from "@/lib/api/mappers";
import type { WorkflowTemplate, WorkspaceSearchResult } from "@/lib/api/types";
import { describeStep, scoreLabel } from "./runs/impact-panel";
import { keepMigration } from "./runs/plan-schema";
import { groupByRepository } from "./search/workspace-search-screen";
import { draftToRequest, EMPTY_DRAFT } from "./settings/templates-settings";
import {
  applyTemplatePrefill,
  templateSummary,
  toCreateTaskRequest,
} from "./tasks/create-task-dialog";

const template = (over: Partial<WorkflowTemplate> = {}): WorkflowTemplate => ({
  key: "bug_fix",
  id: null,
  source: "builtin",
  name: "Bug fix",
  description: "d",
  workflow: "change",
  plan_only: false,
  task_defaults: { title_prefix: "Fix: ", description_template: "## Observed\n", labels: ["bug"] },
  budget: { max_changed_files: 5, max_repair_attempts: 2 },
  allowed_profiles: null,
  planning_guidance: ["a", "b"],
  version: 1,
  status: "active",
  created_at: null,
  updated_at: null,
  ...over,
});

describe("template prefill", () => {
  it("prepends the prefix and fills an empty description", () => {
    expect(
      applyTemplatePrefill({ title: "refresh race", description: "" }, template(), null),
    ).toEqual({
      title: "Fix: refresh race",
      description: "## Observed\n",
    });
  });

  it("swaps prefixes and untouched scaffolds but keeps what the user wrote", () => {
    const refactor = template({
      key: "refactor",
      task_defaults: {
        title_prefix: "Refactor: ",
        description_template: "## Target\n",
        labels: [],
      },
    });
    expect(
      applyTemplatePrefill({ title: "Fix: x", description: "## Observed\n" }, refactor, template()),
    ).toEqual({ title: "Refactor: x", description: "## Target\n" });
    expect(
      applyTemplatePrefill({ title: "Fix: x", description: "my own words" }, null, template()),
    ).toEqual({ title: "x", description: "my own words" });
  });

  it("sends the template key and default labels", () => {
    const v = {
      repository_id: "r",
      source_type: "manual" as const,
      template_key: "bug_fix",
      external_number: "",
      title: "Fix: x",
      description: "long enough",
      start_now: false,
    };
    expect(toCreateTaskRequest(v, template())).toEqual({
      source_type: "manual",
      title: "Fix: x",
      description: "long enough",
      template_key: "bug_fix",
      labels: ["bug"],
    });
    expect(toCreateTaskRequest({ ...v, template_key: "" }, null)).not.toHaveProperty(
      "template_key",
    );
  });

  it("summarizes what a template enforces, including plan-only", () => {
    expect(templateSummary(template())).toContain("at most 5 changed files");
    expect(templateSummary(template({ plan_only: true, workflow: "migration_plan" }))).toMatch(
      /^Plan only/,
    );
  });
});

describe("template admin form", () => {
  it("validates the key and builds a strict body", () => {
    expect(draftToRequest({ ...EMPTY_DRAFT, key: "Bad Key", name: "x" })).toMatchObject({
      ok: false,
      errors: { key: expect.any(String) },
    });
    const r = draftToRequest({
      ...EMPTY_DRAFT,
      key: "security_fix",
      name: "Security fix",
      labels: "security, urgent",
      guidance: "Rule one\n\nRule two",
      restrict_profiles: true,
      profiles: ["node-test"],
      budget: { max_changed_files: "2" },
    });
    expect(r).toEqual({
      ok: true,
      body: {
        key: "security_fix",
        name: "Security fix",
        description: "",
        workflow: "change",
        task_defaults: {
          title_prefix: null,
          description_template: null,
          labels: ["security", "urgent"],
        },
        budget: { max_changed_files: 2 },
        allowed_profiles: ["node-test"],
        planning_guidance: ["Rule one", "Rule two"],
      },
    });
    expect(
      draftToRequest({ ...EMPTY_DRAFT, key: "ok_key", name: "n", budget: { max_steps: "1.5" } }).ok,
    ).toBe(false);
  });
});

describe("impact presentation", () => {
  it("describes evidence steps and labels heuristic strength without numbers as verdicts", () => {
    expect(describeStep({ kind: "imports", from: "a.ts", to: "b.ts", line: 3 })).toBe(
      "a.ts imports b.ts (line 3)",
    );
    expect(
      describeStep({
        kind: "calls",
        from: "a.ts",
        to: "b.ts",
        line: null,
        caller: "f",
        callee: "g",
      }),
    ).toBe("f in a.ts calls g");
    expect([scoreLabel(1), scoreLabel(0.7), scoreLabel(0.4)]).toEqual([
      "strong",
      "moderate",
      "weak",
    ]);
  });

  it("only accepts well-formed test selection records", () => {
    expect(toTestSelection(null)).toBeNull();
    expect(toTestSelection({ mode: "other" })).toBeNull();
    expect(
      toTestSelection({ mode: "narrow", files: ["t.test.js", 3], reasons: { "t.test.js": "x" } }),
    ).toEqual({
      mode: "narrow",
      heuristic: true,
      files: ["t.test.js"],
      reasons: { "t.test.js": "x" },
      test_files_total: 1,
      not_run: 0,
    });
  });
});

describe("plan editing keeps the migration section", () => {
  it("drops rollbacks for removed steps", () => {
    const base = {
      objective: "o",
      assumptions: [],
      files_to_modify: [],
      tests: [],
      risks: [],
      out_of_scope: [],
    };
    const original = {
      ...base,
      steps: [
        { id: "step-1", description: "a", files: [], verification: [] },
        { id: "step-2", description: "b", files: [], verification: [] },
      ],
      migration: {
        affected_areas: [],
        prerequisites: [],
        rollback_strategy: [],
        step_rollback: [
          { step_id: "step-1", rollback: "r1" },
          { step_id: "step-2", rollback: "r2" },
        ],
      },
    };
    const edited = { ...base, steps: [original.steps[0]!] };
    expect(keepMigration(edited, original).migration?.step_rollback).toEqual([
      { step_id: "step-1", rollback: "r1" },
    ]);
    expect(keepMigration(edited, { ...original, migration: undefined })).toEqual(edited);
  });
});

describe("workspace search grouping", () => {
  it("groups by repository in ranking order", () => {
    const r = (repo: string, path: string): WorkspaceSearchResult => ({
      source: "code",
      repository_id: repo,
      repository_full_name: `acme/${repo}`,
      commit_sha: "a".repeat(40),
      path,
      start_line: 1,
      end_line: 2,
      content_hash: "h",
      symbol: null,
      language: null,
      knowledge_document_id: null,
      title: null,
      snippet: "",
      score: 1,
    });
    const groups = groupByRepository([r("a", "1"), r("b", "2"), r("a", "3")]);
    expect(groups.map((g) => [g.name, g.items.map((i) => i.path)])).toEqual([
      ["acme/a", ["1", "3"]],
      ["acme/b", ["2"]],
    ]);
  });
});
