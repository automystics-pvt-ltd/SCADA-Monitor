#!/usr/bin/env bash
# Deploy the Solar SCADA stack on its Ubuntu host.
# Run from any directory with: bash /path/to/SCADA-Monitor/deploy.sh
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

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP_DIR/.env"
BRANCH="main"
COMPOSE_FILES=(
  -f "$APP_DIR/compose.coolify.yaml"
  -f "$APP_DIR/compose.ubuntu.yaml"
)

cd "$APP_DIR"

printf "${CYAN}═══════════════════════════════════════════${NC}\n"
printf "${CYAN}  Deploying Solar SCADA — Ubuntu Compose   ${NC}\n"
printf "${CYAN}═══════════════════════════════════════════${NC}\n"

info "Pre-flight checks"
[[ -f "$ENV_FILE" ]] || fail ".env is missing. Copy deploy/coolify/.env.example to .env and configure production values."
[[ ! -L "$ENV_FILE" ]] || fail ".env must be a regular file, not a symlink."
command -v git >/dev/null 2>&1 || fail "git is not installed."

chmod 600 "$ENV_FILE" || fail "Could not restrict .env permissions."

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
else
  fail "Docker is unavailable. Install Docker Engine and start its service."
fi

"${DOCKER[@]}" compose version >/dev/null 2>&1 \
  || fail "Docker Compose plugin is unavailable. Install the Docker Compose plugin."

compose() {
  "${DOCKER[@]}" compose \
    --project-directory "$APP_DIR" \
    --env-file "$ENV_FILE" \
    "${COMPOSE_FILES[@]}" \
    "$@"
}

compose config --quiet \
  || fail "Compose configuration is invalid or required values are missing from .env."
ok "Environment and Compose configuration are valid"

[[ -d "$APP_DIR/.git" ]] || fail "This directory is not a Git checkout."
CURRENT_BRANCH="$(git branch --show-current)"
[[ "$CURRENT_BRANCH" == "$BRANCH" ]] \
  || fail "Expected Git branch '$BRANCH', found '${CURRENT_BRANCH:-detached HEAD}'."

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "Tracked files have local changes. Commit or stash them before deploying; this script will not discard them."
fi

info "Step 1/3 — Fast-forward code from origin/$BRANCH"
git pull --ff-only origin "$BRANCH" \
  || fail "Could not fast-forward from origin/$BRANCH. Resolve the Git state, then run this script again."
ok "Code is up to date"

compose config --quiet \
  || fail "Updated Compose configuration is invalid or required values are missing from .env."

info "Step 2/3 — Build and start the application"
if ! compose up -d --build --wait --wait-timeout 240; then
  warn "The stack did not become healthy. Current service status:"
  compose ps || true
  fail "Deployment failed. Review the service logs with the commands in deploy/ubuntu/README.md."
fi
ok "Application services are running"

info "Step 3/3 — Show service status"
compose ps

printf "\n${GREEN}═══════════════════════════════════════════${NC}\n"
printf "${GREEN}  Deployment complete                     ${NC}\n"
printf "${GREEN}═══════════════════════════════════════════${NC}\n"
printf "Verify: https://sms.automystics.tech/api/healthz\n"
printf "Logs:   sudo docker compose --env-file .env -f compose.coolify.yaml -f compose.ubuntu.yaml logs --tail=100\n"