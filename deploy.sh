#!/usr/bin/env bash
# Bootstrap and deploy Solar SCADA on Ubuntu.
# Run with: sudo bash deploy.sh
set -Eeuo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { printf "${GREEN}✔  %s${NC}\n" "$*"; }
info() { printf "${CYAN}▶  %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}⚠  %s${NC}\n" "$*"; }
fail() {
  printf "${RED}✘  %s${NC}\n" "$*" >&2
  exit 1
}

REPO_URL="https://github.com/automystics-pvt-ltd/SCADA-Monitor.git"
BRANCH="main"
DEFAULT_APP_DIR="/opt/solar-scada"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${SOLAR_SCADA_DIR:-}" ]]; then
  APP_DIR="${SOLAR_SCADA_DIR:-$DEFAULT_APP_DIR}"
elif [[ -f "$SCRIPT_DIR/compose.coolify.yaml" && -d "$SCRIPT_DIR/.git" ]]; then
  APP_DIR="$SCRIPT_DIR"
else
  APP_DIR="$DEFAULT_APP_DIR"
fi

if (( EUID == 0 )); then
  SUDO=()
else
  command -v sudo >/dev/null 2>&1 || fail "Run this script as root or install sudo."
  SUDO=(sudo)
fi

run_root() {
  if ((${#SUDO[@]})); then
    "${SUDO[@]}" "$@"
  else
    "$@"
  fi
}

compose() {
  run_root docker compose \
    --project-directory "$APP_DIR" \
    --env-file "$APP_DIR/.env" \
    -f "$APP_DIR/compose.coolify.yaml" \
    -f "$APP_DIR/compose.ubuntu.yaml" \
    "$@"
}

printf "${CYAN}═══════════════════════════════════════════${NC}\n"
printf "${CYAN}  Solar SCADA — Ubuntu server deployment   ${NC}\n"
printf "${CYAN}═══════════════════════════════════════════${NC}\n"

[[ -r /etc/os-release ]] || fail "Cannot identify the operating system."
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || fail "This deploy script supports Ubuntu only."
command -v apt-get >/dev/null 2>&1 || fail "apt-get is unavailable on this Ubuntu host."

info "Step 1/6 — Install Git and Docker Compose prerequisites"
if ! command -v git >/dev/null 2>&1; then
  run_root apt-get update
  run_root apt-get install -y git
fi

if ! command -v docker >/dev/null 2>&1 || ! run_root docker compose version >/dev/null 2>&1; then
  run_root apt-get update
  run_root apt-get install -y ca-certificates curl git
  run_root install -m 0755 -d /etc/apt/keyrings
  run_root curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  run_root chmod a+r /etc/apt/keyrings/docker.asc

  ARCH="$(dpkg --print-architecture)"
  CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  [[ -n "$CODENAME" ]] || fail "Could not determine the Ubuntu release codename."
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$ARCH" "$CODENAME" \
    | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null

  run_root apt-get update
  run_root apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi

run_root systemctl enable --now docker
run_root docker info >/dev/null 2>&1 \
  || fail "Docker Engine is not running. Check it with: sudo systemctl status docker"
run_root docker compose version >/dev/null 2>&1 \
  || fail "Docker Compose is unavailable after installation."
ok "Docker Engine and Compose are ready"

info "Step 2/6 — Find or clone the application"
if [[ ! -d "$APP_DIR/.git" ]]; then
  if [[ -d "$APP_DIR" ]] && find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    fail "$APP_DIR exists and is not empty, but is not a Git checkout. Set SOLAR_SCADA_DIR to an empty directory or move that folder's contents safely first."
  fi
  run_root install -d -m 0755 "$(dirname "$APP_DIR")"
  run_root git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR" \
    || fail "Could not clone the repository. Confirm that main is published and this server has approved Git access."
fi

APP_DIR="$(cd -- "$APP_DIR" && pwd)"

ENV_FILE="$APP_DIR/.env"
if [[ ! -e "$ENV_FILE" ]]; then
  run_root cp "$APP_DIR/deploy/coolify/.env.example" "$ENV_FILE"
  run_root chmod 600 "$ENV_FILE"
  fail "Created $ENV_FILE from the template. Fill in its production values, then run this script again."
fi
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "$ENV_FILE must be a regular file, not a symlink."
run_root chmod 600 "$ENV_FILE" || fail "Could not restrict .env permissions."

info "Step 3/6 — Validate checkout and update without discarding local changes"
CURRENT_BRANCH="$(git -C "$APP_DIR" branch --show-current)"
[[ "$CURRENT_BRANCH" == "$BRANCH" ]] \
  || fail "Expected branch '$BRANCH' in $APP_DIR, found '${CURRENT_BRANCH:-detached HEAD}'."

if ! run_root git -C "$APP_DIR" diff --quiet \
  || ! run_root git -C "$APP_DIR" diff --cached --quiet; then
  fail "Tracked files have local changes. Commit or stash them before deploying; this script will not discard them."
fi

run_root git -C "$APP_DIR" pull --ff-only origin "$BRANCH" \
  || fail "Could not fast-forward origin/$BRANCH. Resolve Git access or branch conflicts, then retry."
ok "Repository is up to date"

info "Step 4/6 — Validate the production configuration"
compose config --quiet \
  || fail "Required .env values are missing or Compose configuration is invalid. Do not deploy the example placeholders."
ok "Required database, MQTT, site, and Platform Admin settings are present"

if ! compose ps -q gateway | grep -q . && command -v ss >/dev/null 2>&1; then
  BUSY_WEB_PORTS="$(run_root ss -ltnH | awk '$4 ~ /:(80|443)$/ { print $4 }')"
  [[ -z "$BUSY_WEB_PORTS" ]] \
    || fail "Ports 80/443 are already in use ($BUSY_WEB_PORTS). Free them or configure the existing web server as the reverse proxy before deploying."
fi

info "Step 5/6 — Build and start the application"
if ! compose up -d --build --wait --wait-timeout 240; then
  warn "The services did not become healthy. Current service status:"
  compose ps || true
  fail "Deployment failed. Review container logs with the command printed below."
fi
ok "Application services are healthy"

info "Step 6/6 — Show service status"
compose ps

printf "\n${GREEN}═══════════════════════════════════════════${NC}\n"
printf "${GREEN}  Deployment complete                     ${NC}\n"
printf "${GREEN}═══════════════════════════════════════════${NC}\n"
printf "Verify: https://sms.automystics.tech/api/healthz\n"
printf "Logs:   "
printf 'sudo docker compose --project-directory %q --env-file %q -f %q -f %q logs --tail=100\n' \
  "$APP_DIR" "$ENV_FILE" \
  "$APP_DIR/compose.coolify.yaml" "$APP_DIR/compose.ubuntu.yaml"
printf "\nOpen https://sms.automystics.tech/ and https://sms.automystics.tech/platform-admin/\n"
printf "Ensure provider firewall and DNS route the domain to this server; allow TCP 80/443 and UDP 443 if HTTP/3 is desired.\n"