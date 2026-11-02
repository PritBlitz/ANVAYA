export { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";

const REASONS: Record<string, string> = {
  secret: "Secrets",
  dependency: "Dependencies",
  build_output: "Build output",
  generated: "Generated",
  binary: "Binary",
  configured: "Configured",
  size_limit: "Too large",
  unsupported_language: "Unsupported",
};

export function humanizeReason(reason: string): string {
  return REASONS[reason] ?? reason.replace(/_/g, " ");
}
