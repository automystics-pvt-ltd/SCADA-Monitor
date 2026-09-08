# Coolify deployment

This project is deployed as one Docker Compose stack behind a single public
domain:

- `/` serves the MQTT SCADA Monitor.
- `/platform-admin/` serves Platform Admin.
- `/api/*` routes to the API server without rewriting the API path.

Keeping one origin is required for the existing cookie sessions, API calls, and
MQTT server-sent events.

## Create the Coolify resource

1. Push this repository to the Git provider connected to Coolify.
2. In Coolify, create a **Docker Compose** application from the repository.
3. Set the compose file to `compose.coolify.yaml`.
4. Assign the public domain to the `gateway` service on port `80`.
5. Do not expose the `api`, `mqtt-scada-monitor`, or `platform-admin` services
   publicly.

The gateway configuration is copied into its image during the build. No
repository files are bind-mounted at runtime, which keeps the stack compatible
with Coolify's isolated deployment directories.

## Environment variables

Copy the variable names from `deploy/coolify/.env.example` into Coolify's
environment settings. Store passwords and secrets as Coolify secrets; do not
commit a populated `.env` file.

At minimum, configure:

- `DATABASE_URL`
- `SESSION_SECRET`
- the MQTT broker variables used by the plant
- either Google OAuth or SMTP credentials for Platform Admin

If Google OAuth is enabled, register this production callback URL with the
provider:

`https://YOUR_DOMAIN/api/platform-admin/google/callback`

The API stores its retryable MQTT snapshot queue in the named `scada-runtime`
volume. PostgreSQL remains external to this compose stack so it can be managed
and backed up independently by Coolify.

## Deploy and verify

Deploy the compose application, then verify:

```text
https://YOUR_DOMAIN/coolify-health
https://YOUR_DOMAIN/api/healthz
https://YOUR_DOMAIN/
https://YOUR_DOMAIN/platform-admin/
```

The gateway disables response buffering for `/api/*`, allowing the MQTT SSE
stream to update the monitor continuously.

## Database schema

Point `DATABASE_URL` at the intended production PostgreSQL database. Apply the
project's schema to that database before allowing operators to sign in:

```sh
DATABASE_URL='postgresql://...' pnpm --filter @workspace/db run push
```

Run schema changes from a controlled Coolify terminal/job and review them before
applying. Migrating existing Replit data is a separate operation; this stack
does not copy database records automatically.
