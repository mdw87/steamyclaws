#!/bin/bash
# nspawn-bootstrap.sh — Bootstrap NanoClaw agent rootfs for systemd-nspawn
#
# Usage: sudo bash scripts/nspawn-bootstrap.sh [--force]
#
# Must be run as root (sudo) to avoid user namespace permission issues
# with bind-mounted directories.
#
# Bootstrap strategy (tried in order):
#   1. Docker export  — if Docker is available; fastest, reuses Dockerfile
#   2. pacstrap       — if arch-install-scripts is installed (Arch/SteamOS)
#   3. Arch tarball   — downloads Arch bootstrap from geo.mirror.pkgbuild.com
#   4. debootstrap    — for Debian/Ubuntu systems
#
# All paths are under $HOME to stay within the writable filesystem.
# On Steam Deck, $HOME is /home/deck (or /root when run with sudo).

set -euo pipefail

ROOTFS_DIR="/root/.local/share/nanoclaw/rootfs"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FORCE="${1:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[nspawn-bootstrap]${NC} $*"; }
warn()  { echo -e "${YELLOW}[nspawn-bootstrap] WARNING:${NC} $*"; }
error() { echo -e "${RED}[nspawn-bootstrap] ERROR:${NC} $*" >&2; }

if [[ "$(id -u)" != "0" ]]; then
  error "This script must be run as root: sudo bash scripts/nspawn-bootstrap.sh"
  exit 1
fi

# Detect Steam Deck
if grep -q 'ID=steamos' /etc/os-release 2>/dev/null; then
  warn "Steam Deck detected."
  warn "Rootfs at $ROOTFS_DIR survives reboots but may be lost after a full system recovery."
fi

# Check if already bootstrapped
if [[ -d "$ROOTFS_DIR/usr/bin" && "$FORCE" != "--force" ]]; then
  log "Rootfs already exists at $ROOTFS_DIR"
  log "Run with --force to rebuild from scratch."
  exit 0
fi

if [[ "$FORCE" == "--force" ]]; then
  log "Force mode: removing existing rootfs..."
  rm -rf "$ROOTFS_DIR"
fi

mkdir -p "$ROOTFS_DIR"

# ── Helper: install agent components into the rootfs ──────────────────────────

install_agent() {
  log "Installing Node.js dependencies for agent-runner..."

  local AGENT_SRC="$PROJECT_ROOT/container/agent-runner"
  mkdir -p "$ROOTFS_DIR/app"

  # Copy package files
  cp "$AGENT_SRC/package.json" "$ROOTFS_DIR/app/"
  [[ -f "$AGENT_SRC/package-lock.json" ]] && cp "$AGENT_SRC/package-lock.json" "$ROOTFS_DIR/app/"
  cp "$AGENT_SRC/tsconfig.json" "$ROOTFS_DIR/app/"

  # Install npm deps inside rootfs (as root inside the container)
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe --network-host -- \
    npm install --prefix /app --omit=dev 2>&1 | sed 's/^/  /'

  # Install global tools
  log "Installing global npm packages (claude-code, agent-browser)..."
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe --network-host -- \
    npm install -g @anthropic-ai/claude-code agent-browser 2>&1 | sed 's/^/  /'

  # Write entrypoint script
  # Runs as root inside nspawn, chowns workspace to node, then su's to node for the agent
  cat > "$ROOTFS_DIR/app/entrypoint.sh" << 'ENTRYPOINT_EOF'
#!/bin/bash
set -e

# Fix bind-mount ownership: dirs are created by root (host orchestrator), but the
# node user needs write access. chown here is safe — no user namespace mapping when
# NanoClaw runs as root, so container UID 1000 = host UID 1000.
chown -R node:node /workspace /home/node/.claude 2>/dev/null || true

# Compile agent-runner from mounted source (overwrites compiled output each run)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Read stdin into a file (must happen before su since su doesn't inherit stdin the same way)
cat > /tmp/input.json
chmod 644 /tmp/input.json

# Switch to node user (non-root required by --dangerously-skip-permissions in claude-code)
exec su -s /bin/bash node -c 'node /tmp/dist/index.js < /tmp/input.json'
ENTRYPOINT_EOF
  chmod +x "$ROOTFS_DIR/app/entrypoint.sh"

  # Set up workspace directory structure
  log "Creating workspace directories..."
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe -- \
    mkdir -p /workspace/group /workspace/global /workspace/extra \
             /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

  # Set ownership of workspace to node user
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe -- \
    chown -R node:node /workspace /home/node
  chmod 755 "$ROOTFS_DIR/home/node"

  log "Agent components installed."
}

# ── Strategy 1: Docker export ──────────────────────────────────────────────────

bootstrap_from_docker() {
  log "Strategy 1: Docker export"
  log "Building Docker image (nanoclaw-agent:latest)..."
  docker build -t nanoclaw-agent:latest "$PROJECT_ROOT/container"

  log "Exporting container filesystem..."
  local CONTAINER_ID
  CONTAINER_ID=$(docker create nanoclaw-agent:latest)
  docker export "$CONTAINER_ID" | tar -C "$ROOTFS_DIR" -xf -
  docker rm "$CONTAINER_ID" >/dev/null

  # The Docker-exported rootfs has the node user, /app, /workspace, and entrypoint.sh
  # but the entrypoint.sh uses the original Docker logic (runs as node from the start).
  # Overwrite it with the nspawn version that chowns workspace before su'ing to node.
  cat > "$ROOTFS_DIR/app/entrypoint.sh" << 'ENTRYPOINT_EOF'
#!/bin/bash
set -e
chown -R node:node /workspace /home/node/.claude 2>/dev/null || true
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
chmod 644 /tmp/input.json
exec su -s /bin/bash node -c 'node /tmp/dist/index.js < /tmp/input.json'
ENTRYPOINT_EOF
  chmod +x "$ROOTFS_DIR/app/entrypoint.sh"

  log "Docker export complete."
}

# ── Strategy 2: pacstrap (Arch, already installed) ────────────────────────────

bootstrap_from_pacstrap() {
  log "Strategy 2: pacstrap"
  pacstrap -c "$ROOTFS_DIR" base nodejs npm chromium git curl

  # Create node user (uid 1000) inside the rootfs
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe -- \
    useradd -m -u 1000 -g 1000 -s /bin/bash node 2>/dev/null || true

  install_agent
}

# ── Strategy 3: Arch Linux bootstrap tarball (Steam Deck, no pacstrap) ────────

bootstrap_from_arch_tarball() {
  log "Strategy 3: Arch Linux bootstrap tarball"
  local ARCH_MIRROR="https://geo.mirror.pkgbuild.com/iso/latest"
  local TMP_DIR
  TMP_DIR=$(mktemp -d)
  trap "rm -rf $TMP_DIR" EXIT

  log "Finding latest Arch bootstrap tarball..."
  # Try zst first, fall back to gz
  local TARBALL_NAME
  TARBALL_NAME=$(curl -sSf "$ARCH_MIRROR/" \
    | grep -oP 'archlinux-bootstrap-x86_64\.tar\.(zst|gz)' \
    | head -1) || true

  if [[ -z "$TARBALL_NAME" ]]; then
    error "Could not find Arch bootstrap tarball at $ARCH_MIRROR/"
    return 1
  fi

  log "Downloading $ARCH_MIRROR/$TARBALL_NAME ..."
  curl -Lf "$ARCH_MIRROR/$TARBALL_NAME" -o "$TMP_DIR/bootstrap.tar"

  log "Extracting..."
  tar -C "$TMP_DIR" -xf "$TMP_DIR/bootstrap.tar"

  local ROOT_DIR="$TMP_DIR/root.x86_64"
  if [[ ! -d "$ROOT_DIR" ]]; then
    error "Expected root.x86_64/ in bootstrap tarball, not found"
    return 1
  fi

  # Move contents (including hidden dirs) to rootfs
  find "$ROOT_DIR" -maxdepth 1 -mindepth 1 -exec mv {} "$ROOTFS_DIR/" \;

  # Configure pacman mirror
  cat > "$ROOTFS_DIR/etc/pacman.d/mirrorlist" << 'EOF'
Server = https://geo.mirror.pkgbuild.com/$repo/os/$arch
Server = https://mirror.rackspace.com/archlinux/$repo/os/$arch
EOF

  log "Initializing pacman keyring (this may take a minute)..."
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe -- pacman-key --init
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe -- pacman-key --populate archlinux

  log "Installing Node.js, Chromium, and tools..."
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe --network-host -- \
    pacman -Sy --noconfirm nodejs npm chromium git curl

  # Create node user (uid 1000)
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe -- \
    useradd -m -u 1000 -g 1000 -s /bin/bash node 2>/dev/null || true

  install_agent
}

# ── Strategy 4: Debian debootstrap ────────────────────────────────────────────

bootstrap_from_debian() {
  log "Strategy 4: Debian debootstrap"

  if ! command -v debootstrap &>/dev/null; then
    error "debootstrap not found. Install it: sudo apt-get install debootstrap"
    return 1
  fi

  debootstrap --include=curl,git,ca-certificates bookworm "$ROOTFS_DIR"

  log "Installing Node.js (via NodeSource)..."
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe --network-host -- bash -c "
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs chromium
    apt-get clean
  "

  # Create node user (uid 1000)
  systemd-nspawn --directory="$ROOTFS_DIR" --pipe -- \
    useradd -m -u 1000 -g 1000 -s /bin/bash node 2>/dev/null || true

  install_agent
}

# ── Select bootstrap strategy ──────────────────────────────────────────────────

log "Selecting bootstrap strategy..."

if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  log "Docker available — using Docker export (fastest)"
  bootstrap_from_docker

elif command -v pacstrap &>/dev/null; then
  log "pacstrap available — using pacstrap"
  bootstrap_from_pacstrap

elif uname -m | grep -qE '^x86_64$' && command -v curl &>/dev/null; then
  log "No Docker or pacstrap — downloading Arch Linux bootstrap tarball"
  bootstrap_from_arch_tarball

elif command -v debootstrap &>/dev/null; then
  log "debootstrap available — using Debian bootstrap"
  bootstrap_from_debian

else
  error "No bootstrap method available. Options:"
  error "  1. Install Docker and re-run (easiest)"
  error "  2. Install debootstrap: sudo apt-get install debootstrap"
  error "  3. On Arch/SteamOS: ensure curl is available for the Arch tarball method"
  error "  4. On Steam Deck: open Desktop Mode, open terminal, then re-run"
  exit 1
fi

# ── Quick smoke test ───────────────────────────────────────────────────────────

log ""
log "Running smoke test..."
RESULT=$(systemd-nspawn \
  --directory="$ROOTFS_DIR" \
  --pipe --network-host \
  -- node --version 2>&1) || true

if echo "$RESULT" | grep -q '^v'; then
  log "Node.js version in rootfs: $RESULT"
  log ""
  log "Rootfs ready at $ROOTFS_DIR"
  log ""
  log "Next steps:"
  log "  1. npm run build           (compile NanoClaw)"
  log "  2. Install systemd service (see SKILL.md Phase 4)"
else
  warn "Could not verify Node.js in rootfs. Output: $RESULT"
  warn "The rootfs may still be functional — check manually:"
  warn "  sudo systemd-nspawn --directory=$ROOTFS_DIR --pipe -- node --version"
fi
