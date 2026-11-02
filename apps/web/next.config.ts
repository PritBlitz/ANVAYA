import path from "node:path";
import type { NextConfig } from "next";

/**
 * API transport (see docs/frontend/API_INTEGRATION.md):
 * - The browser always calls the same-origin path `/api/v1`.
 * - In `http` mode Next.js rewrites `/api/v1/*` to the NestJS control plane at
 *   `ANVAYA_API_ORIGIN` (server-only env var). Same-origin requests keep the
 *   HttpOnly session cookie first-party and avoid CORS for SSE.
 * - In `fixtures` mode no rewrite is registered; the in-browser fixture adapter
 *   answers requests instead.
 */
const apiOrigin = process.env.ANVAYA_API_ORIGIN;

/**
 * Content-Security-Policy. Static (no nonces) on purpose: nonces force every page to
 * render dynamically, and the public homepage must stay static (M11). Next's inline
 * bootstrap scripts therefore need 'unsafe-inline'; everything else is locked to
 * same-origin, framing is denied, plugins are off, and forms/base URIs can't be
 * redirected. GitHub avatars are the only third-party images. Dev needs eval for
 * React Refresh and a websocket for HMR.
 */
const isDev = process.env.NODE_ENV !== "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://avatars.githubusercontent.com",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://github.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // E2E builds into its own directory so it never overwrites a running server's build.
  distDir: process.env.ANVAYA_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  turbopack: {
    // apps/web is self-contained (own node_modules and lockfile): pin the root so a
    // lockfile elsewhere in the monorepo can't change how modules resolve.
    root: path.join(__dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    if (!apiOrigin) return [];
    return [
      { source: "/api/v1/:path*", destination: `${apiOrigin.replace(/\/$/, "")}/api/v1/:path*` },
    ];
  },
};

export default nextConfig;
