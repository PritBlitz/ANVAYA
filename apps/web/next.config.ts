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

const securityHeaders = [
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
