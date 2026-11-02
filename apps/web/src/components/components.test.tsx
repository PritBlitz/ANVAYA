import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RichText } from "@/components/domain/rich-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/states";
import { CodeView } from "@/features/code/code-view";
import { FileTree } from "@/features/code/file-tree";
import { ApiError } from "@/lib/api/errors";
import type { TreeEntry } from "@/lib/api/types";

describe("Field", () => {
  it("connects label, hint and error to the control", () => {
    const { rerender } = render(
      <Field label="Title" hint="Short and clear" required>
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText(/Title/);
    expect(input).toHaveAccessibleDescription("Short and clear");
    expect(input).toHaveAttribute("aria-required", "true");
    rerender(
      <Field label="Title" hint="Short and clear" error="Too short" required>
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText(/Title/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Title/)).toHaveAccessibleDescription("Too short");
  });

  it("supports composite controls via render prop", () => {
    render(
      <Field label="URL">
        {(control) => (
          <div>
            <span>prefix/</span>
            <input {...control} />
          </div>
        )}
      </Field>,
    );
    expect(screen.getByLabelText("URL").tagName).toBe("INPUT");
  });
});

describe("Button", () => {
  it("is disabled and busy while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Badge", () => {
  it("renders text, never color alone", () => {
    render(
      <Badge tone="danger" dot>
        Failed
      </Badge>,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("shows request ID and hides retry for 403", () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        error={
          new ApiError({
            status: 403,
            code: "FORBIDDEN",
            message: "Admins only.",
            requestId: "req_42",
          })
        }
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Admins only.");
    expect(screen.getByText(/req_42/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("offers retry for network errors", async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        error={new ApiError({ status: 0, code: "NETWORK_ERROR", message: "x" })}
        onRetry={onRetry}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("RichText", () => {
  it("renders model output as text, never as HTML", () => {
    const { container } = render(
      <RichText
        text={'<img src=x onerror="alert(1)"> and `code` and **bold**\n\n- item [1]'}
        renderCitation={(n) => <a href={`#c${n}`}>{n}</a>}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "1" })).toHaveAttribute("href", "#c1");
    expect(screen.getByRole("listitem")).toBeInTheDocument();
  });
});

describe("CodeView", () => {
  it("numbers lines and marks the cited range", () => {
    render(<CodeView content={"a\nb\nc\nd"} startLine={10} highlight={{ start: 11, end: 12 }} />);
    const current = document.querySelector('[aria-current="location"]');
    expect(current).toHaveAttribute("data-line", "11");
    expect(screen.getByText("13")).toBeInTheDocument();
  });
});

describe("FileTree", () => {
  const entries: TreeEntry[] = [
    {
      path: "src",
      name: "src",
      type: "directory",
      children: [
        { path: "src/a.ts", name: "a.ts", type: "file" },
        { path: "src/b.ts", name: "b.ts", type: "file" },
      ],
    },
    { path: ".env", name: ".env", type: "file", is_excluded: true, exclusion_reason: "secret" },
    { path: "README.md", name: "README.md", type: "file" },
  ];

  it("supports keyboard navigation per WAI-ARIA tree pattern", async () => {
    const onSelect = vi.fn();
    render(<FileTree entries={entries} selectedPath={null} onSelect={onSelect} />);
    const user = userEvent.setup();
    const src = screen.getByRole("treeitem", { name: /src/ });
    expect(src).toHaveAttribute("aria-expanded", "true");
    src.focus();
    await user.keyboard("{ArrowLeft}");
    expect(src).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("treeitem", { name: /a\.ts/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("src/b.ts");
    await user.keyboard("{End}");
    expect(screen.getByRole("treeitem", { name: /README/ })).toHaveFocus();
  });

  it("does not open excluded files", async () => {
    const onSelect = vi.fn();
    render(<FileTree entries={entries} selectedPath={null} onSelect={onSelect} />);
    const env = screen.getByRole("treeitem", { name: /\.env/ });
    expect(env).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(env);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
