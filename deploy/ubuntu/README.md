# Deploy on an Ubuntu server with Docker Compose

This deploys the application directly on Ubuntu with Docker Compose. The Ubuntu
override publishes the gateway on ports 80/443 and lets Caddy obtain and renew
HTTPS certificates for `PUBLIC_DOMAIN`.

## Requirements

- A public Ubuntu server with `sudo` access and outbound internet access. The
  deployment script installs Docker Engine and the Compose plugin if needed.
- A DNS `A` record for `PUBLIC_DOMAIN` pointing to the server's public IPv4
  address. Point `AAAA` there only if IPv6 is configured and reachable.
- Inbound TCP ports 80 and 443 open in the server firewall and provider
  firewall. UDP 443 is optional and enables HTTP/3.
- A PostgreSQL database reachable from the server. `DATABASE_URL` must point to
  that database; this stack does not provision PostgreSQL or copy Replit data.

## 1. Get the deployment script onto the server

First, sync the deployment files to the repository's `main` branch. The project
must contain the latest `deploy.sh`, Compose files, and Ubuntu Caddyfile before
the server can use them. Then clone it into a dedicated application directory:

```sh
sudo git clone --branch main --single-branch \
  https://github.com/automystics-pvt-ltd/SCADA-Monitor.git \
  /opt/solar-scada
sudo bash /opt/solar-scada/deploy.sh
```

The script installs Docker if needed, creates `.env` from the template if it is
missing, and safely stops so you can fill in its values. If the repository
requires authentication, configure approved Git access first; do not put a
GitHub token in the clone URL. Run the script from any directory using its full
path; it deploys from `/opt/solar-scada`, not from the current web-root folder.

## 2. Open the required ports

Allow inbound TCP ports 80 and 443 in the server provider's firewall/security
group. If Ubuntu UFW is already active, allow SSH and web traffic:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw status
```

UDP 443 is optional. Do not enable UFW remotely unless SSH is allowed. The
script does not enable or change the host firewall.

## 3. Configure production values

The first script run creates `/opt/solar-scada/.env` if needed and reports its
location. Edit that file, not a `.env` in the hosting panel's `htdocs` directory:

```sh
sudo nano /opt/solar-scada/.env
```

Set `PUBLIC_DOMAIN=sms.automystics.tech` and fill in the blank values in `.env`.
The Ubuntu Compose configuration intentionally rejects missing database,
MQTT/site, and Platform Admin authentication settings instead of starting with
example addresses or silently disconnected telemetry. `DATABASE_URL` must be
an external PostgreSQL connection reachable from this server, and its schema
must already be prepared.

`PLATFORM_ADMIN_EMAILS` must include an active, already-provisioned admin
account. Configure both Google OAuth and Gmail SMTP because both sign-in
methods are presented in the app. Register this Google callback URL with the
OAuth client:

```text
https://sms.automystics.tech/api/platform-admin/google/callback
```

For Gmail SMTP, use the account and app password configured for the sender.
Generate a long session secret on the server with:

```sh
openssl rand -hex 32
```

Keep the generated value private and enter it only in `.env`. Do not commit
`.env`.

## 4. Deploy

Run this from any directory for both the first deploy and later updates:

```sh
sudo bash /opt/solar-scada/deploy.sh
```

The script installs/starts Docker, updates the checkout from `origin/main`
using fast-forward-only Git, validates `.env`, checks whether ports 80/443 are
already occupied, builds the images, waits for service health checks, and prints
status. It will not discard local changes. It does not run database schema
changes automatically; apply reviewed schema changes separately before
deploying code that depends on them.

## 5. Check status and logs

```sh
sudo docker compose --project-directory /opt/solar-scada \
  --env-file /opt/solar-scada/.env \
  -f /opt/solar-scada/compose.coolify.yaml \
  -f /opt/solar-scada/compose.ubuntu.yaml ps

sudo docker compose --project-directory /opt/solar-scada \
  --env-file /opt/solar-scada/.env \
  -f /opt/solar-scada/compose.coolify.yaml \
  -f /opt/solar-scada/compose.ubuntu.yaml logs --tail=100
```

Wait for Caddy to obtain its certificate, then verify HTTPS and routing:

```sh
curl -fsS https://sms.automystics.tech/coolify-health
curl -fsS https://sms.automystics.tech/api/healthz
```

Then open `https://sms.automystics.tech/` and
`https://sms.automystics.tech/platform-admin/`.

The Caddy data volume preserves automatically issued certificates. The
`scada-runtime` volume preserves the API's retryable MQTT snapshot queue. Keep
these volumes when updating the application.