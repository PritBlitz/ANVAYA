"use client";

import { Check, Link2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { splitLines, segmentMatches, type LineRange } from "@/lib/code";
import { TOKEN_CLASS, tokenizeLines, type Token } from "@/lib/syntax";
import { cn } from "@/lib/utils/cn";

/**
 * Line-numbered, read-only source view. Highlights a cited range and scrolls it into
 * view. Text is rendered as text nodes only — repository content is untrusted and is
 * never injected as HTML.
 */
export function CodeView({
  content,
  highlight,
  startLine = 1,
  terms = [],
  className,
  maxHeight,
  onLineClick,
  label,
  language,
}: {
  content: string;
  /** Enables syntax highlighting for known languages (FD-8). */
  language?: string | null;
  highlight?: LineRange | null;
  startLine?: number;
  terms?: string[];
  className?: string;
  maxHeight?: number | string;
  onLineClick?: (line: number) => void;
  label?: string;
}) {
  const lines = useMemo(() => splitLines(content), [content]);
  const tokens = useMemo(() => tokenizeLines(lines, language), [lines, language]);
  const containerRef = useRef<HTMLDivElement>(null);
  const gutterWidth = String(startLine + lines.length).length;

  useEffect(() => {
    if (!highlight || !containerRef.current) return;
    const el = containerRef.current.querySelector<HTMLElement>(`[data-line="${highlight.start}"]`);
    if (!el) return;
    const container = containerRef.current;
    if (container.scrollHeight > container.clientHeight) {
      container.scrollTop = Math.max(0, el.offsetTop - container.clientHeight / 4);
    } else {
      el.scrollIntoView?.({ block: "center" });
    }
  }, [highlight, content]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={label ?? "Source code"}
      tabIndex={0}
      style={{ maxHeight }}
      className={cn(
        "scrollbar-thin overflow-auto bg-surface-sunken font-mono text-[12.5px] leading-[1.6rem] focus-visible:outline-2 focus-visible:-outline-offset-2",
        className,
      )}
    >
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((text, i) => {
            const n = startLine + i;
            const inRange = !!highlight && n >= highlight.start && n <= highlight.end;
            return (
              <tr
                key={n}
                data-line={n}
                className={cn(inRange && "bg-highlight")}
                aria-current={inRange && n === highlight?.start ? "location" : undefined}
              >
                <td
                  className={cn(
                    "sticky left-0 w-px border-r px-3 text-right align-top text-fg-subtle select-none",
                    inRange
                      ? "border-highlight-border bg-highlight text-accent-fg"
                      : "border-border bg-surface-sunken",
                    onLineClick && "cursor-pointer hover:text-fg",
                  )}
                  style={{ minWidth: `${gutterWidth + 2}ch` }}
                  onClick={onLineClick ? () => onLineClick(n) : undefined}
                >
                  {n}
                </td>
                <td className="pr-4 pl-4 whitespace-pre text-fg">
                  <LineContent text={text} tokens={tokens?.[i]} terms={terms} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One line as text nodes: syntax tokens, with search terms marked inside them. */
function LineContent({
  text,
  tokens,
  terms,
}: {
  text: string;
  tokens: Token[] | undefined;
  terms: string[];
}) {
  if (!text) return " ";
  const parts = tokens ?? [{ text, kind: "plain" as const }];
  if (!tokens && !terms.length) return text;
  return parts.map((tok, j) => {
    const cls = TOKEN_CLASS[tok.kind];
    const inner = terms.length
      ? segmentMatches(tok.text, terms).map((seg, k) =>
          seg.match ? (
            <mark key={k} className="rounded-xs bg-highlight-border/60 text-fg">
              {seg.text}
            </mark>
          ) : (
            seg.text
          ),
        )
      : tok.text;
    return cls ? (
      <span key={j} className={cls}>
        {inner}
      </span>
    ) : (
      <span key={j}>{inner}</span>
    );
  });
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  icon = <Link2 />,
}: {
  value: string | (() => string);
  label?: string;
  copiedLabel?: string;
  icon?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(typeof value === "function" ? value() : value);
          setCopied(true);
        } catch {
          // clipboard unavailable (permissions / insecure context)
        }
      }}
    >
      {copied ? <Check /> : icon}
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </Button>
  );
}
