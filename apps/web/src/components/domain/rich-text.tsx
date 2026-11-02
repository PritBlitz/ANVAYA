import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe renderer for model-generated text: paragraphs, "- " bullet lists,
 * `inline code`, **bold**, and [n] citation markers. It produces React nodes only —
 * never HTML — because model output is untrusted (CLAUDE.md §9).
 */
export function RichText({
  text,
  renderCitation,
}: {
  text: string;
  renderCitation?: (n: number) => ReactNode;
}) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <div className="flex flex-col gap-2.5 text-sm leading-relaxed text-fg">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*] /.test(l))) {
          return (
            <ul key={i} className="flex list-disc flex-col gap-1 pl-5 marker:text-fg-subtle">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*] /, ""), renderCitation)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l, renderCitation)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function inline(text: string, renderCitation?: (n: number) => ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[\d+\])/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const token = m[0];
    if (token.startsWith("`")) {
      out.push(
        <code
          key={key++}
          className="rounded-xs bg-surface-sunken px-1 py-px font-mono text-[0.85em] text-fg"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      const n = Number(token.slice(1, -1));
      out.push(renderCitation ? <Fragment key={key++}>{renderCitation(n)}</Fragment> : token);
    }
    last = idx + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
