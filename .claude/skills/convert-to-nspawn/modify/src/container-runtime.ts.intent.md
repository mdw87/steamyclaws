# Intent: src/container-runtime.ts modifications

## What changed
Replaced Docker/Apple Container runtime with systemd-nspawn. This is a full file replacement — the exported API is extended (new exports for nspawn-specific arg construction) while existing exports remain API-compatible.

## Key sections

### CONTAINER_RUNTIME_BIN
- Changed: `'docker'` → `'systemd-nspawn'`

### NSPAWN_ROOTFS_DIR (new export)
- New: `~/.local/share/nanoclaw/rootfs` — the directory tree used as the container filesystem
- Exported so bootstrap scripts and tests can reference the canonical path

### readonlyMountArgs
- Changed: Docker `-v host:container:ro` → nspawn `--bind-ro=host:container`

### writableMountArgs (new export)
- New: returns `['--bind=host:container']` for writable bind mounts
- Needed because Docker's `-v` is hardcoded in container-runner.ts; nspawn uses `--bind=`

### containerPreamble (new export)
- New: returns the opening CLI args for a systemd-nspawn invocation
- Replaces Docker's `['run', '-i', '--rm', '--name', name, '-e', 'TZ=...', '--user', 'uid:gid']`
- Includes: --directory, --machine, --pipe, --network-host, --tmpfs=/tmp, --setenv=TZ, --setenv=HOME, --chdir
- No --user= flag: user switching to `node` happens inside entrypoint.sh via `su node`
- No --private-users: when NanoClaw runs as root (system service), nspawn disables user namespaces automatically

### containerSuffix (new export)
- New: returns `['--', '/app/entrypoint.sh']`
- Replaces Docker's `[CONTAINER_IMAGE]` at the end of the args array
- The `--` separator is required by nspawn to separate options from the command

### stopContainer
- Changed: `docker stop <name>` → `machinectl terminate <name>`
- machinectl sends SIGTERM to the container's leader process via systemd-machined

### ensureContainerRuntimeRunning
- Changed: `docker info` → `systemd-nspawn --version`
- nspawn is stateless (no daemon to start), so we only check binary availability
- Error message updated for nspawn installation instructions

### cleanupOrphans
- Changed: `docker ps --filter name=nanoclaw- --format '{{.Names}}'` → `machinectl list --no-legend --no-pager`
- machinectl output format: `<name>  <class>  <service>  <os>  <version>` — first field is the machine name
- Filters on `nanoclaw-` prefix (same logic as Docker version)

## Invariants
- All original exports remain: `CONTAINER_RUNTIME_BIN`, `readonlyMountArgs`, `stopContainer`, `ensureContainerRuntimeRunning`, `cleanupOrphans`
- New exports added: `NSPAWN_ROOTFS_DIR`, `writableMountArgs`, `containerPreamble`, `containerSuffix`
- Logger usage pattern unchanged
- Error handling pattern (box-drawing output) unchanged
- `stopContainer` still returns a shell command string (consumed by `exec()` in container-runner.ts)

## Must-keep
- The exported function signatures (consumed by container-runner.ts)
- The error box-drawing output format
- The orphan cleanup logic (find + stop pattern)
- `containerPreamble` and `containerSuffix` must together produce a complete nspawn invocation when combined with bind mount args
