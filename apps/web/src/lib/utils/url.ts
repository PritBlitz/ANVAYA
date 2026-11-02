/**
 * Only same-origin, absolute-path redirects are allowed after sign-in.
 * Rejects protocol-relative ("//evil.com"), backslash tricks, and schemes.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
  if (!next) return fallback;
  let decoded = next;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return fallback;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\"))
    return fallback;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(decoded)) return fallback;
  if (decoded.startsWith("/login")) return fallback;
  return decoded;
}
