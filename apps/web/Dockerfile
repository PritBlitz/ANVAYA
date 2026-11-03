# syntax=docker/dockerfile:1.7
# Anvaya web (Next.js) in http mode. Build context: apps/web
#
# Next.js fixes rewrites at build time, so the API origin the server proxies /api/v1/* to is a build
# argument: the compose stack uses http://api:3001; the AWS deployment uses the API's Cloud Map name.
#   docker build --build-arg ANVAYA_API_ORIGIN=http://api:3001 -t anvaya-web:<sha> apps/web
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG ANVAYA_API_ORIGIN=http://api:3001
ARG NEXT_PUBLIC_GITHUB_APP_SLUG=anvaya-dev
ENV NEXT_PUBLIC_API_MODE=http \
    ANVAYA_API_ORIGIN=${ANVAYA_API_ORIGIN} \
    NEXT_PUBLIC_GITHUB_APP_SLUG=${NEXT_PUBLIC_GITHUB_APP_SLUG} \
    NEXT_TELEMETRY_DISABLED=1 \
    ANVAYA_STANDALONE=1
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone server plus the static assets it serves; no source or dev dependencies.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# No public/ directory: every asset is imported and fingerprinted under .next/static.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["node", "server.js"]
