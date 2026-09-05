# syntax=docker/dockerfile:1
# RevenuePulse Worker (pg-boss job consumer) — build from repo root:
#   docker build -t revenuepulse-worker -f apps/worker/Dockerfile .

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
ENV NEXT_TELEMETRY_DISABLED=1

# ── Dependencies ───────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/database/package.json packages/database/
COPY packages/auth/package.json packages/auth/
COPY packages/domain/package.json packages/domain/
COPY packages/policies/package.json packages/policies/
COPY packages/observability/package.json packages/observability/
COPY packages/agent/package.json packages/agent/
COPY packages/providers/package.json packages/providers/
COPY packages/razorpay/package.json packages/razorpay/
COPY apps/worker/package.json apps/worker/
COPY jsconfig.json tsconfig.json turbo.json ./
RUN npm install

# ── Build / generate Prisma client ─────────────────────────────────────────
FROM deps AS builder
COPY . .
WORKDIR /app/packages/database
RUN npx prisma generate

# ── Runner ─────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/jsconfig.json ./

# The worker consumes from PostgreSQL via pg-boss. LP worker stays resident.
CMD ["npx", "tsx", "apps/worker/index.ts"]
