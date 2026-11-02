/** Unified diff parsing for the Changes view. Pure, dependency-free, unit-tested. */

export type DiffLineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** Display path: new path unless the file was deleted. */
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(p: string): string | null {
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const finish = () => {
    if (!file) return;
    file.path = file.newPath ?? file.oldPath ?? "unknown";
    if (file.status !== "renamed") {
      file.status =
        file.oldPath === null ? "added" : file.newPath === null ? "deleted" : "modified";
    }
    files.push(file);
  };

  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      finish();
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = {
        oldPath: m?.[1] ?? null,
        newPath: m?.[2] ?? null,
        path: "",
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
        binary: false,
      };
      hunk = null;
      continue;
    }
    if (!file) {
      // Diffs without "diff --git" headers start directly with ---/+++.
      if (raw.startsWith("--- ")) {
        file = {
          oldPath: null,
          newPath: null,
          path: "",
          status: "modified",
          additions: 0,
          deletions: 0,
          hunks: [],
          binary: false,
        };
      } else continue;
    }
    if (!hunk) {
      if (raw.startsWith("--- ")) {
        file.oldPath = stripPrefix(raw.slice(4).trim());
        continue;
      }
      if (raw.startsWith("+++ ")) {
        file.newPath = stripPrefix(raw.slice(4).trim());
        continue;
      }
      if (raw.startsWith("rename from ")) {
        file.oldPath = raw.slice(12);
        file.status = "renamed";
        continue;
      }
      if (raw.startsWith("rename to ")) {
        file.newPath = raw.slice(10);
        file.status = "renamed";
        continue;
      }
      if (raw.startsWith("new file mode")) {
        file.oldPath = null;
        continue;
      }
      if (raw.startsWith("deleted file mode")) {
        file.newPath = null;
        continue;
      }
      if (raw.startsWith("Binary files")) {
        file.binary = true;
        continue;
      }
    }
    const h = raw.match(HUNK_RE);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      hunk = {
        header: raw,
        oldStart: oldNo,
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: newNo,
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldNumber: null, newNumber: newNo++ });
      file.additions++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldNumber: oldNo++, newNumber: null });
      file.deletions++;
    } else if (raw.startsWith(" ")) {
      hunk.lines.push({
        kind: "context",
        text: raw.slice(1),
        oldNumber: oldNo++,
        newNumber: newNo++,
      });
    } else if (raw.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: raw, oldNumber: null, newNumber: null });
    }
  }
  finish();
  return files;
}

/** Files changed outside the approved plan scope (AI_WORKFLOW §2.4). */
export function outOfScopeFiles(changed: string[], approved: string[]): string[] {
  const allowed = new Set(approved);
  return changed.filter((p) => !allowed.has(p));
}
