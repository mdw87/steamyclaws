import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  NSPAWN_ROOTFS_DIR,
  readonlyMountArgs,
  writableMountArgs,
  containerPreamble,
  containerSuffix,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure / structural functions ---

describe('CONTAINER_RUNTIME_BIN', () => {
  it('is systemd-nspawn', () => {
    expect(CONTAINER_RUNTIME_BIN).toBe('systemd-nspawn');
  });
});

describe('NSPAWN_ROOTFS_DIR', () => {
  it('is under the home directory', () => {
    expect(NSPAWN_ROOTFS_DIR).toContain('.local/share/nanoclaw/rootfs');
  });
});

describe('readonlyMountArgs', () => {
  it('returns --bind-ro= with host:container', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['--bind-ro=/host/path:/container/path']);
  });
});

describe('writableMountArgs', () => {
  it('returns --bind= with host:container', () => {
    const args = writableMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['--bind=/host/path:/container/path']);
  });
});

describe('stopContainer', () => {
  it('returns machinectl terminate command', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      'machinectl terminate nanoclaw-test-123',
    );
  });
});

describe('containerPreamble', () => {
  it('includes --directory pointing to rootfs', () => {
    const args = containerPreamble('nanoclaw-test-456');
    expect(args.some((a) => a.startsWith('--directory='))).toBe(true);
    expect(args.some((a) => a.includes('nanoclaw/rootfs'))).toBe(true);
  });

  it('includes --machine with the container name', () => {
    const args = containerPreamble('nanoclaw-mygroup-111');
    expect(args).toContain('--machine=nanoclaw-mygroup-111');
  });

  it('includes --pipe for stdin/stdout passthrough', () => {
    const args = containerPreamble('nanoclaw-test');
    expect(args).toContain('--pipe');
  });

  it('includes --network-host for internet access', () => {
    const args = containerPreamble('nanoclaw-test');
    expect(args).toContain('--network-host');
  });

  it('includes --tmpfs=/tmp for isolated temp space', () => {
    const args = containerPreamble('nanoclaw-test');
    expect(args.some((a) => a.startsWith('--tmpfs=/tmp'))).toBe(true);
  });

  it('includes TZ environment variable', () => {
    const args = containerPreamble('nanoclaw-test');
    expect(args.some((a) => a.startsWith('--setenv=TZ='))).toBe(true);
  });

  it('does not include --user= (user switching happens in entrypoint.sh)', () => {
    const args = containerPreamble('nanoclaw-test');
    expect(args.some((a) => a.startsWith('--user='))).toBe(false);
  });
});

describe('containerSuffix', () => {
  it('returns -- followed by the entrypoint path', () => {
    expect(containerSuffix()).toEqual(['--', '/app/entrypoint.sh']);
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when systemd-nspawn is available', () => {
    mockExecSync.mockReturnValueOnce('systemd-nspawn 255\n...');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} --version`,
      { stdio: 'pipe', timeout: 5000 },
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime (systemd-nspawn) available',
    );
  });

  it('throws when systemd-nspawn is not found', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('command not found: systemd-nspawn');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops running nanoclaw- machines from machinectl list output', () => {
    // machinectl list --no-legend --no-pager output format: name  class  service  os  version
    const listOutput = [
      'nanoclaw-group1-111  container  nspawn  arch  -',
      'nanoclaw-group2-222  container  nspawn  arch  -',
      'other-machine        container  nspawn  debian -',
    ].join('\n');
    mockExecSync.mockReturnValueOnce(listOutput);
    mockExecSync.mockReturnValue(''); // stop calls succeed

    cleanupOrphans();

    // list + 2 stop calls (only nanoclaw- prefixed)
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'machinectl terminate nanoclaw-group1-111',
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      'machinectl terminate nanoclaw-group2-222',
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no nanoclaw machines are running', () => {
    mockExecSync.mockReturnValueOnce('other-machine  container  nspawn  debian -\n');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('does nothing when machinectl returns empty output', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when machinectl list fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Failed to connect to machine bus');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining machines when one stop fails', () => {
    const listOutput = [
      'nanoclaw-a-1  container  nspawn  arch  -',
      'nanoclaw-b-2  container  nspawn  arch  -',
    ].join('\n');
    mockExecSync.mockReturnValueOnce(listOutput);
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('machine not found');
    });
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});
