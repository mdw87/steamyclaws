/**
 * Container runtime abstraction for NanoClaw — systemd-nspawn backend.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'systemd-nspawn';

/** Root filesystem directory for the nspawn container. Must be writable by the process owner. */
export const NSPAWN_ROOTFS_DIR = path.join(
  os.homedir(),
  '.local',
  'share',
  'nanoclaw',
  'rootfs',
);

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [`--bind-ro=${hostPath}:${containerPath}`];
}

/** Returns CLI args for a writable bind mount. */
export function writableMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [`--bind=${hostPath}:${containerPath}`];
}

/**
 * Returns the opening CLI args for a systemd-nspawn container invocation.
 *
 * Design notes:
 * - --pipe: passes stdin/stdout/stderr through, equivalent to Docker's -i
 * - --network-host: shares host network so agents can reach the Anthropic API
 * - --tmpfs=/tmp: each container gets isolated in-memory /tmp (for tsc output
 *   and input.json); prevents concurrent container collisions on the shared rootfs
 * - No --user= here: the container starts as root so entrypoint.sh can chown
 *   bind-mounted workspace dirs to the node user before switching via `su node`
 * - No --private-users: when NanoClaw runs as root (system service), nspawn
 *   does not create user namespaces by default, avoiding UID mapping issues
 */
export function containerPreamble(containerName: string): string[] {
  return [
    `--directory=${NSPAWN_ROOTFS_DIR}`,
    `--machine=${containerName}`,
    '--pipe',
    '--network-host',
    '--tmpfs=/tmp:mode=1777',
    `--setenv=TZ=${TIMEZONE}`,
    '--setenv=HOME=/home/node',
    '--chdir=/workspace/group',
  ];
}

/** Returns the closing CLI args: command separator + container entrypoint. */
export function containerSuffix(): string[] {
  return ['--', '/app/entrypoint.sh'];
}

/** Returns the shell command to gracefully terminate a container by machine name. */
export function stopContainer(name: string): string {
  return `machinectl terminate ${name}`;
}

/** Ensure systemd-nspawn is available and the rootfs directory exists. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} --version`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    logger.debug('Container runtime (systemd-nspawn) available');
  } catch (err) {
    logger.error({ err }, 'Failed to find systemd-nspawn');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: systemd-nspawn not found                               ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Install systemd-container                                  ║',
    );
    console.error(
      '║     Debian/Ubuntu: sudo apt-get install systemd-container      ║',
    );
    console.error(
      '║     Arch/SteamOS:  pacman -S systemd (already included)        ║',
    );
    console.error(
      '║  2. Bootstrap the rootfs: sudo bash scripts/nspawn-bootstrap.sh║',
    );
    console.error(
      '║  3. Verify: systemd-nspawn --version                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers (nspawn machines) from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`machinectl list --no-legend --no-pager`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const lines = output.trim().split('\n').filter(Boolean);
    // machinectl list output format: "<name>  <class>  <service>  <os>  <version>"
    const orphans = lines
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name?.startsWith('nanoclaw-'));
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
