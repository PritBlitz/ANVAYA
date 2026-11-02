import { anim } from "./motion";

/**
 * Trust boundaries (ARCHITECTURE.md §3, SECURITY.md §3) as an animated diagram.
 * Flows animate; the sandbox and hosted-model paths are visually fenced off.
 */
export function TrustDiagram() {
  const flow = (delay = 0) => ({
    ...anim("mk-flow", { duration: 1100, delay, iteration: "infinite", easing: "linear" }),
  });
  const box = "fill-[var(--surface)] stroke-[var(--border-strong)]";
  const label = "fill-[var(--fg)] text-[15px] font-medium";
  const sub = "fill-[var(--fg-muted)] text-[12px]";
  return (
    <svg
      viewBox="0 0 860 360"
      role="img"
      aria-labelledby="trust-title trust-desc"
      className="h-auto w-full"
    >
      <title id="trust-title">Anvaya trust boundaries</title>
      <desc id="trust-desc">
        The browser talks only to the control plane. The control plane coordinates workers, which
        call local models by default and hosted models only when the workspace opts in. Repository
        code runs only inside an isolated sandbox with network egress denied. Pull requests reach
        GitHub only after human approval.
      </desc>
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" className="fill-[var(--fg-subtle)]" />
        </marker>
      </defs>

      {/* Flows */}
      <g className="fill-none stroke-[var(--primary)]" strokeWidth="2" strokeDasharray="6 6">
        <path className="mk-anim" d="M150 180 H245" markerEnd="url(#arrow)" style={flow()} />
        <path className="mk-anim" d="M415 180 H500" markerEnd="url(#arrow)" style={flow(200)} />
        <path className="mk-anim" d="M650 150 L705 95" markerEnd="url(#arrow)" style={flow(400)} />
        <path className="mk-anim" d="M650 210 L705 265" markerEnd="url(#arrow)" style={flow(600)} />
      </g>
      <g className="fill-none stroke-[var(--fg-subtle)]" strokeWidth="1.5" strokeDasharray="3 5">
        <path className="mk-anim" d="M330 140 V70 H700" markerEnd="url(#arrow)" style={flow(300)} />
      </g>

      {/* Browser */}
      <rect x="20" y="140" width="130" height="80" rx="10" className={box} />
      <text x="85" y="172" textAnchor="middle" className={label}>
        Browser
      </text>
      <text x="85" y="196" textAnchor="middle" className={sub}>
        no secrets
      </text>
      <text x="85" y="211" textAnchor="middle" className={sub}>
        no model calls
      </text>

      {/* Control plane */}
      <rect
        x="245"
        y="140"
        width="170"
        height="80"
        rx="10"
        className="fill-[var(--primary-soft)] stroke-[var(--primary)]"
      />
      <text x="330" y="174" textAnchor="middle" className={label}>
        Control plane
      </text>
      <text x="330" y="193" textAnchor="middle" className={sub}>
        authorization · approvals
      </text>
      <text x="330" y="207" textAnchor="middle" className={sub}>
        audit · budgets
      </text>

      {/* Workers */}
      <rect x="500" y="140" width="150" height="80" rx="10" className={box} />
      <text x="575" y="176" textAnchor="middle" className={label}>
        Workers
      </text>
      <text x="575" y="196" textAnchor="middle" className={sub}>
        index · orchestrate
      </text>

      {/* Models */}
      <rect x="705" y="30" width="140" height="62" rx="10" className={box} />
      <text x="775" y="56" textAnchor="middle" className={label}>
        Local model
      </text>
      <text x="775" y="74" textAnchor="middle" className={sub}>
        default · Ollama
      </text>
      <rect
        x="705"
        y="112"
        width="140"
        height="50"
        rx="10"
        className="fill-none stroke-[var(--border-strong)]"
        strokeDasharray="5 4"
      />
      <text x="775" y="134" textAnchor="middle" className={sub}>
        Hosted model
      </text>
      <text x="775" y="150" textAnchor="middle" className={sub}>
        opt-in only
      </text>

      {/* Sandbox boundary */}
      <rect
        x="690"
        y="215"
        width="160"
        height="125"
        rx="12"
        className="fill-none stroke-[var(--warning)]"
        strokeDasharray="6 5"
        strokeWidth="1.5"
      />
      <text
        x="770"
        y="234"
        textAnchor="middle"
        className="fill-[var(--warning)] text-[10px] font-semibold tracking-wide"
      >
        ISOLATED · EGRESS DENIED
      </text>
      <rect x="705" y="245" width="130" height="80" rx="10" className={box} />
      <text x="770" y="279" textAnchor="middle" className={label}>
        Sandbox
      </text>
      <text x="770" y="298" textAnchor="middle" className={sub}>
        runs repo code
      </text>
      <text x="770" y="312" textAnchor="middle" className={sub}>
        fixed profiles
      </text>

      {/* GitHub with approval gate */}
      <rect x="245" y="270" width="170" height="64" rx="10" className={box} />
      <text x="330" y="298" textAnchor="middle" className={label}>
        GitHub
      </text>
      <text x="330" y="316" textAnchor="middle" className={sub}>
        short-lived tokens
      </text>
      <path
        d="M330 220 V270"
        className="fill-none stroke-[var(--success)]"
        strokeWidth="2"
        markerEnd="url(#arrow)"
      />
      <rect
        x="342"
        y="232"
        width="118"
        height="24"
        rx="12"
        className="fill-[var(--success-soft)] stroke-[var(--success-border)]"
      />
      <text
        x="401"
        y="248"
        textAnchor="middle"
        className="fill-[var(--success)] text-[10.5px] font-semibold"
      >
        human approval
      </text>
    </svg>
  );
}
