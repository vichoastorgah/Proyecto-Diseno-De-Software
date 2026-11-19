# Single-service image for Render (or any container host): the Deno API also serves the
# built React app, so the whole system has one public URL (no CORS, one Google origin).
# The container is stateless: data lives in Supabase Postgres (DATABASE_URL) and attachments
# in Supabase Storage (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). On Render the server
# refuses to start without them (the container disk is wiped on every restart).

# ---------- 1. Build the frontend ----------
FROM node:22.23.3-alpine AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
# Same origin as the API: relative URLs. The Google client id is read at runtime from
# /api/config, so the image does not depend on build-time secrets or URLs.
ENV VITE_API_BASE_URL=""
RUN npm run build

# ---------- 2. API runtime ----------
FROM denoland/deno:2.9.7

WORKDIR /app
RUN chown deno:deno /app

# Everything (dependency cache included) belongs to the unprivileged user that runs the API.
USER deno
COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno server ./server
RUN deno install --entrypoint server/server.ts
COPY --from=client --chown=deno:deno /client/dist ./public

ENV STATIC_DIR=/app/public
# Render injects PORT; 8000 is only the local default.
ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["deno", "eval", "const r = await fetch(`http://127.0.0.1:${Deno.env.get('PORT') ?? 8000}/api/health`); if (!r.ok) Deno.exit(1);"]

CMD ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-sys", "server/server.ts"]
