# Deploy on an Ubuntu server with Docker Compose

This uses the same Compose stack as the Coolify deployment, with an Ubuntu
override that publishes the gateway on ports 80/443 and lets Caddy obtain and
renew HTTPS certificates for `PUBLIC_DOMAIN`.

## Requirements

- A public Ubuntu server with Docker Engine and the Docker Compose plugin.
- A DNS `A` record for `PUBLIC_DOMAIN` pointing to the server's public IPv4
  address. Point `AAAA` there only if IPv6 is configured and reachable.
- Inbound TCP ports 80 and 443 open in the server firewall and provider
  firewall. UDP 443 is optional and enables HTTP/3.
- A PostgreSQL database reachable from the server. `DATABASE_URL` must point to
  that database; this stack does not provision PostgreSQL or copy Replit data.

## 1. Install Docker

Run on Ubuntu 22.04 or 24.04:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
```

## 2. Open the required ports

Allow inbound TCP ports 80 and 443 in the server provider's firewall/security
group. If Ubuntu UFW is active, allow SSH first, then web traffic:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw status
```

UDP 443 is optional. Do not enable UFW remotely unless SSH is allowed.

## 3. Clone the repository

```sh
git clone --branch main \
  https://github.com/automystics-pvt-ltd/SCADA-Monitor.git
cd SCADA-Monitor
```

If Git reports that the repository requires authentication, configure repository
access on the server using your organization's approved method; do not place a
GitHub token directly in the clone URL.

## 4. Configure production values

From the repository root:

```sh
cp deploy/coolify/.env.example .env
chmod 600 .env
nano .env
```

Set `PUBLIC_DOMAIN=sms.automystics.io` and configure `DATABASE_URL`,
`SESSION_SECRET`, the plant's MQTT values, and Platform Admin email/auth
settings. `DATABASE_URL` must be an external PostgreSQL connection reachable
from this server, and its schema must already be prepared. Generate a long
session secret with:

```sh
openssl rand -hex 32
```

Keep the generated value private and enter it only in `.env`. Do not commit
`.env`.

## 5. Deploy

From the repository root, run:

```sh
bash deploy.sh
```

The script validates `.env` and the Compose configuration, fast-forwards the
checkout from `origin/main` without discarding local changes, builds the images,
starts the services, waits for their health checks, and prints their status. It
does not run database schema changes automatically. Apply reviewed schema
changes separately before deploying code that depends on them; do not use a
forced schema push as an unattended deployment step.

## 6. Check status and logs

```sh
sudo docker compose \
  --env-file .env \
  -f compose.coolify.yaml \
  -f compose.ubuntu.yaml \
  ps

sudo docker compose \
  --env-file .env \
  -f compose.coolify.yaml \
  -f compose.ubuntu.yaml \
  logs --tail=100 gateway api
```

Wait for Caddy to obtain its certificate, then verify HTTPS and routing:

```sh
curl -fsS https://sms.automystics.io/coolify-health
curl -fsS https://sms.automystics.io/api/healthz
```

Then open `https://sms.automystics.io/` and
`https://sms.automystics.io/platform-admin/`.

## Update after a code change

After committing and pushing the change to `main`, run this from the repository
root on the server:

```sh
bash deploy.sh
```

The Caddy data volume preserves automatically issued certificates. The
`scada-runtime` volume preserves the API's retryable MQTT snapshot queue. Keep
these volumes when updating the application.