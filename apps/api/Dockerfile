# syntax=docker/dockerfile:1.7
# Anvaya API / worker image. The same image runs both:
#   API:    node dist/main.js
#   Worker: node dist/main.worker.js
# Build context: apps/api
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts are disabled: tree-sitter grammars are used only as prebuilt WASM.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY openapi.json ./openapi.json
# Amazon RDS CA bundle, so DATABASE_URL can use sslmode=verify-full (infra/aws). Pinned by checksum:
# a changed bundle fails the build instead of being trusted silently.
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b   https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
# ADD creates /app/certs root-only; the unprivileged runtime user must be able to read the bundle.
RUN chmod 0755 /app/certs
# Unprivileged runtime user; no shell tooling is needed at runtime.
RUN addgroup -S anvaya && adduser -S -G anvaya -H anvaya && mkdir -p /app/storage /app/workspaces && chown anvaya:anvaya /app/storage /app/workspaces
USER anvaya
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3001/api/v1/health/live || exit 1
CMD ["node", "dist/main.js"]
