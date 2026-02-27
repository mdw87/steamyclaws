---
name: convert-to-nspawn
description: Switch container runtime to systemd-nspawn for Linux systems where Docker is unavailable, particularly Steam Deck (SteamOS/Arch-based). Triggers on "nspawn", "convert to nspawn", "systemd-nspawn", "steam deck", or "docker unavailable".
---

# Convert to systemd-nspawn

This skill switches NanoClaw's container runtime from Docker/Apple Container to systemd-nspawn, a lightweight container runtime included with systemd. It targets Linux systems where Docker is unavailable, particularly **Steam Deck** (SteamOS, Arch-based, immutable rootfs).

**What this changes:**
- Container runtime: `docker` → `systemd-nspawn`
- Container rootfs: OCI image → directory tree at `~/.local/share/nanoclaw/rootfs`
- Mount syntax: `-v host:container` → `--bind=host:container`
- Readonly mounts: `-v h:c:ro` → `--bind-ro=h:c`
- Env vars: `-e KEY=VALUE` → `--setenv=KEY=VALUE`
- Container naming: `--name` → `--machine`
- Container stop: `docker stop` → `machinectl terminate`
- Startup check: `docker info` → `systemd-nspawn --version`
- Writable mounts: new `writableMountArgs()` export in `container-runtime.ts`
- Arg construction: new `containerPreamble()` and `containerSuffix()` exports
- Service: systemd system service (replaces launchd on macOS)

**What stays the same:**
- Container runner streaming/IPC logic (`src/container-runner.ts` logic)
- Mount security/allowlist validation
- All other functionality

**Security model:**
The NanoClaw orchestrator runs as root (system service). Agents run as the non-root `node` user inside nspawn containers. Container filesystem isolation is at the OS level via nspawn's namespacing. Running the orchestrator as root is the standard pattern for nspawn-based services and is required to avoid user namespace mapping issues with bind-mounted directories.

> ⚠️ **Steam Deck note:** All data paths are under `~/.local/share/nanoclaw/` and survive reboots. The systemd service file at `/etc/systemd/system/nanoclaw.service` also survives routine SteamOS updates but may be lost in a full system recovery — re-run the install step if needed.

## Prerequisites

Run these checks before starting:

```bash
# Check systemd-nspawn is available
systemd-nspawn --version && echo "OK" || echo "MISSING: install systemd-container"

# Check machinectl is available
machinectl --version && echo "OK" || echo "MISSING: install systemd"

# Check current runtime
grep "CONTAINER_RUNTIME_BIN" src/container-runtime.ts
```

If systemd-nspawn is missing:
- Debian/Ubuntu: `sudo apt-get install systemd-container`
- Arch/SteamOS: it's part of systemd (`pacman -S systemd`)

### Steam Deck desktop mode

Open a terminal (Konsole) from Desktop Mode. The `deck` user has sudo access:
```bash
sudo -v  # confirm sudo works
```

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `convert-to-nspawn` is in `applied_skills`, skip to Phase 4 (Verify). The code changes are already in place.

### Check current runtime

```bash
grep "CONTAINER_RUNTIME_BIN" src/container-runtime.ts
```

If it already shows `'systemd-nspawn'`, skip to Phase 4.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` does not exist:
```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply container-runtime.ts replacement

```bash
npx tsx scripts/apply-skill.ts .claude/skills/convert-to-nspawn
```

This deterministically:
- Replaces `src/container-runtime.ts` with the nspawn implementation
- Replaces `src/container-runtime.test.ts` with nspawn-specific tests
- Records the application in `.nanoclaw/state.yaml`

If apply reports merge conflicts, read the intent files:
- `modify/src/container-runtime.ts.intent.md`
- `modify/src/container-runner.ts.intent.md`

### Update container-runner.ts imports and buildContainerArgs

The skills engine does not replace `container-runner.ts` because it's a large file with only targeted changes. Apply these edits manually:

**Step 1: Update imports**

In `src/container-runner.ts`, find the existing import from `./container-runtime.js`:
```typescript
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
```

Replace it with:
```typescript
import {
  CONTAINER_RUNTIME_BIN,
  containerPreamble,
  containerSuffix,
  readonlyMountArgs,
  stopContainer,
  writableMountArgs,
} from './container-runtime.js';
```

Then, in the same file, find the existing import from `./config.js`:
```typescript
import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
```

Replace it with (removing `CONTAINER_IMAGE` and `TIMEZONE`, which are now in container-runtime.ts):
```typescript
import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
```

**Step 2: Replace buildContainerArgs**

Find the `buildContainerArgs` function in `src/container-runner.ts` and replace the entire function body:

```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = [...containerPreamble(containerName)];

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push(...writableMountArgs(mount.hostPath, mount.containerPath));
    }
  }

  args.push(...containerSuffix());
  return args;
}
```

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before continuing.

## Phase 3: Bootstrap the rootfs

The rootfs is a directory tree that nspawn uses as the container filesystem. It lives at `~/.local/share/nanoclaw/rootfs` to stay within the user's writable home directory (important for Steam Deck).

Run the bootstrap script:
```bash
sudo bash scripts/nspawn-bootstrap.sh
```

The script auto-detects the best bootstrap method:
1. **Docker export** (if Docker is available — fastest, reuses Dockerfile)
2. **Arch Linux bootstrap tarball** (for Steam Deck and Arch systems without Docker)
3. **Debian debootstrap** (for Debian/Ubuntu systems)

The bootstrap takes several minutes on first run (downloads packages). Subsequent runs skip if the rootfs already exists.

To force a rebuild:
```bash
sudo bash scripts/nspawn-bootstrap.sh --force
```

### Test the rootfs

```bash
sudo systemd-nspawn \
  --directory=/root/.local/share/nanoclaw/rootfs \
  --pipe --network-host \
  -- node --version
```

Expected: prints a Node.js version like `v22.x.x`.

> **Note on rootfs path:** The bootstrap script creates the rootfs in `$HOME/.local/share/nanoclaw/rootfs`. When run with `sudo`, `$HOME` is root's home (`/root`). NanoClaw (running as root via the system service) reads `NSPAWN_ROOTFS_DIR` which uses `os.homedir()` — when running as root, this is `/root`. Verify this matches:
> ```bash
> sudo node -e "const os=require('os'); console.log(os.homedir())"
> ```

## Phase 4: Install systemd service

### Build NanoClaw

```bash
npm run build
```

### Install the service

Get the absolute project path:
```bash
PROJECT_ROOT="$(pwd)"
NODE_BIN="$(which node)"
echo "PROJECT_ROOT: $PROJECT_ROOT"
echo "NODE_BIN: $NODE_BIN"
```

Generate and install the service file (replaces placeholders):
```bash
sudo sed \
  -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
  -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
  systemd/nanoclaw.service \
  > /etc/systemd/system/nanoclaw.service

sudo systemctl daemon-reload
sudo systemctl enable --now nanoclaw
```

Verify it started:
```bash
sudo systemctl status nanoclaw
sudo journalctl -u nanoclaw -f
```

### Managing the service

```bash
sudo systemctl start nanoclaw
sudo systemctl stop nanoclaw
sudo systemctl restart nanoclaw
sudo journalctl -u nanoclaw --since "10 minutes ago"
```

## Phase 5: Verify

### Test nspawn spawning

```bash
# Verify machinectl can see containers
sudo systemd-nspawn \
  --directory=/root/.local/share/nanoclaw/rootfs \
  --machine=nanoclaw-test-verify \
  --pipe --network-host --tmpfs=/tmp:mode=1777 \
  -- /bin/bash -c "node --version && echo 'nspawn OK'"
```

### Test bind mounts and agent entrypoint

Create a test input and verify the entrypoint runs:
```bash
echo '{"prompt":"Say hello","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  sudo systemd-nspawn \
    --directory=/root/.local/share/nanoclaw/rootfs \
    --machine=nanoclaw-test-agent \
    --pipe --network-host \
    --tmpfs=/tmp:mode=1777 \
    -- /app/entrypoint.sh
```

This should compile the agent runner and attempt to run (it will fail without proper mounts and API key, but should get past the entrypoint and tsc steps).

### Full integration test

Send a message via your configured channel (WhatsApp, Telegram, etc.) and verify the agent responds.

Check logs if issues arise:
```bash
sudo journalctl -u nanoclaw --since "5 minutes ago"
```

## Troubleshooting

**`systemd-nspawn` not found:**
- Debian/Ubuntu: `sudo apt-get install systemd-container`
- Arch/SteamOS: `systemd-nspawn` is part of `systemd` (`pacman -S systemd`)
- Verify: `systemd-nspawn --version`

**Bootstrap fails with "user namespace" errors:**
- The bootstrap must be run with `sudo` to avoid user namespace mapping issues
- Verify: `sudo bash scripts/nspawn-bootstrap.sh`

**`machinectl terminate` fails:**
- machined may not be running: `sudo systemctl start systemd-machined`
- The container will still be killed by the process-level fallback in container-runner.ts

**Node user permission denied in container:**
- The entrypoint.sh runs `chown -R node:node /workspace` before switching users
- If this fails, check the bind-mounted directory permissions on the host
- As a debug step: `sudo ls -la ~/.local/share/nanoclaw/rootfs/workspace/`

**Container can't reach the internet:**
- Verify: `sudo systemd-nspawn --directory=/root/.local/share/nanoclaw/rootfs --pipe --network-host -- curl -s https://api.anthropic.com`
- `--network-host` shares the host network stack — if the host has internet, the container does too

**Steam Deck: service file lost after system update:**
- This happens on major SteamOS updates that reset `/etc`
- Re-run the service install step from Phase 4

**Docker was used for bootstrap but is no longer available:**
- The rootfs is self-contained once created — Docker is only needed for the initial bootstrap
- To rebuild without Docker: `sudo rm -rf /root/.local/share/nanoclaw/rootfs && sudo bash scripts/nspawn-bootstrap.sh`

## Summary of Changed Files

| File | Type of Change |
|------|----------------|
| `src/container-runtime.ts` | Full replacement — nspawn implementation |
| `src/container-runtime.test.ts` | Full replacement — tests for nspawn behavior |
| `src/container-runner.ts` | Targeted edits — imports + `buildContainerArgs` only |
| `scripts/nspawn-bootstrap.sh` | New file — rootfs bootstrap script |
| `systemd/nanoclaw.service` | New file — systemd system service template |
