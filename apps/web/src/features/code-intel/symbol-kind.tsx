import { Badge, type Tone } from "@/components/ui/badge";

const KIND_TONE: Record<string, Tone> = {
  function: "info",
  method: "info",
  class: "primary",
  interface: "accent",
  type: "accent",
  module: "neutral",
};

const KIND_ABBR: Record<string, string> = {
  function: "fn",
  method: "m",
  class: "C",
  interface: "I",
  type: "T",
  module: "mod",
};

/** Kind badge; unknown kinds from newer parsers render as neutral text. */
export function SymbolKindBadge({ kind, compact }: { kind: string; compact?: boolean }) {
  return (
    <Badge
      tone={KIND_TONE[kind] ?? "neutral"}
      title={kind}
      className={compact ? "w-9 justify-center font-mono" : undefined}
    >
      {compact ? (KIND_ABBR[kind] ?? kind.slice(0, 3)) : kind}
    </Badge>
  );
}

export const REFERENCE_LABEL: Record<string, string> = {
  calls: "Calls",
  extends: "Extends",
  instantiates: "Instantiates",
  imports: "Imports",
};

export const INCOMING_LABEL: Record<string, string> = {
  calls: "Called by",
  extends: "Extended by",
  instantiates: "Instantiated by",
  imports: "Imported by",
};
