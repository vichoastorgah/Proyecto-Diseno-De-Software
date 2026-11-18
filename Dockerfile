# API container (Deno + Oak). Used by Render (or any container host).
# The API is stateless: data lives in Supabase Postgres (DATABASE_URL) and attachments in
# Supabase Storage (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). The frontend is deployed
# separately (Vercel), so client/ is not part of this image.
FROM denoland/deno:2.9.7

WORKDIR /app
RUN chown deno:deno /app

# Everything (dependency cache included) belongs to the unprivileged user that runs the API.
USER deno
COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno server ./server
RUN deno install --entrypoint server/server.ts

# Render injects PORT; 8000 is only the local default.
ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["deno", "eval", "const r = await fetch(`http://127.0.0.1:${Deno.env.get('PORT') ?? 8000}/api/health`); if (!r.ok) Deno.exit(1);"]

CMD ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-sys", "server/server.ts"]
