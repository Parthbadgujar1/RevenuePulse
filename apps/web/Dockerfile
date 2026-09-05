# syntax=docker/dockerfile:1
# RevenuePulse Web (Next.js standalone) — build from repo root:
#   docker build -t revenuepulse-web -f apps/web/Dockerfile .

FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
ENV NEXT_TELEMETRY_DISABLED=1

# ── Installer ──────────────────────────────────────────────────────────────
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
COPY apps/web/package.json apps/web/
COPY jsconfig.json tsconfig.json turbo.json ./
RUN npm install

# ── Builder (generate Prisma client + Next standalone) ─────────────────────
FROM deps AS builder
COPY . .
WORKDIR /app/packages/database
RUN npx prisma generate
WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate 2>/dev/null || true
RUN npm run build

# ── Runner ─────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
# Prisma 7 generates the client into packages/database/prisma/generated/
# (not node_modules/.prisma) and Next's standalone trace inlines the
# @rp/database workspace package into the server bundle directly, so no
# extra node_modules copy is needed here — just the generated client
# sources for anything that reads the schema/migrations at runtime.
COPY --from=builder /app/packages/database/prisma ./packages/database/prisma

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The web server writes to /app/apps/web/server.js via standalone output.
WORKDIR /app/apps/web
CMD ["sh", "-c", "node server.js"]
