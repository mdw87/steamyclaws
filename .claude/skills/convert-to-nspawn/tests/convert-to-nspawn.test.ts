import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('convert-to-nspawn skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: convert-to-nspawn');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('container-runtime.ts');
  });

  it('has the container-runtime.ts replacement', () => {
    const runtimeFile = path.join(
      skillDir,
      'modify',
      'src',
      'container-runtime.ts',
    );
    expect(fs.existsSync(runtimeFile)).toBe(true);

    const content = fs.readFileSync(runtimeFile, 'utf-8');
    expect(content).toContain("CONTAINER_RUNTIME_BIN = 'systemd-nspawn'");
    expect(content).toContain('NSPAWN_ROOTFS_DIR');
    expect(content).toContain('writableMountArgs');
    expect(content).toContain('containerPreamble');
    expect(content).toContain('containerSuffix');
    expect(content).toContain('machinectl terminate');
  });

  it('uses nspawn-specific patterns (not Docker)', () => {
    const runtimeFile = path.join(
      skillDir,
      'modify',
      'src',
      'container-runtime.ts',
    );
    const content = fs.readFileSync(runtimeFile, 'utf-8');

    // nspawn patterns
    expect(content).toContain('--bind-ro=');
    expect(content).toContain('--bind=');
    expect(content).toContain('--pipe');
    expect(content).toContain('--network-host');
    expect(content).toContain('machinectl list');
    expect(content).toContain('/app/entrypoint.sh');

    // Must NOT contain Docker patterns
    expect(content).not.toContain("CONTAINER_RUNTIME_BIN = 'docker'");
    expect(content).not.toContain("CONTAINER_RUNTIME_BIN = 'container'");
    expect(content).not.toContain('docker info');
    expect(content).not.toContain("'-v'");
    expect(content).not.toContain("':ro'");
    expect(content).not.toContain('--filter name=');
  });

  it('has the container-runtime.test.ts replacement', () => {
    const testFile = path.join(
      skillDir,
      'modify',
      'src',
      'container-runtime.test.ts',
    );
    expect(fs.existsSync(testFile)).toBe(true);

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toContain('writableMountArgs');
    expect(content).toContain('containerPreamble');
    expect(content).toContain('containerSuffix');
    expect(content).toContain('machinectl terminate');
    expect(content).toContain('--bind-ro=');
    expect(content).toContain('--bind=');
  });

  it('has intent files for all modified sources', () => {
    const runtimeIntent = path.join(
      skillDir,
      'modify',
      'src',
      'container-runtime.ts.intent.md',
    );
    expect(fs.existsSync(runtimeIntent)).toBe(true);

    const runnerIntent = path.join(
      skillDir,
      'modify',
      'src',
      'container-runner.ts.intent.md',
    );
    expect(fs.existsSync(runnerIntent)).toBe(true);
  });

  it('has the bootstrap script', () => {
    const bootstrapFile = path.join(
      skillDir,
      'add',
      'scripts',
      'nspawn-bootstrap.sh',
    );
    expect(fs.existsSync(bootstrapFile)).toBe(true);

    const content = fs.readFileSync(bootstrapFile, 'utf-8');
    // Must have all four bootstrap strategies
    expect(content).toContain('docker export');
    expect(content).toContain('pacstrap');
    expect(content).toContain('Arch Linux bootstrap tarball');
    expect(content).toContain('debootstrap');
    // Must create the entrypoint that su's to node
    expect(content).toContain('su -s /bin/bash node');
    // Must have rootfs path under /root/.local
    expect(content).toContain('.local/share/nanoclaw/rootfs');
    // Must require root
    expect(content).toContain('id -u');
  });

  it('has the systemd service template', () => {
    const serviceFile = path.join(
      skillDir,
      'add',
      'systemd',
      'nanoclaw.service',
    );
    expect(fs.existsSync(serviceFile)).toBe(true);

    const content = fs.readFileSync(serviceFile, 'utf-8');
    expect(content).toContain('[Unit]');
    expect(content).toContain('[Service]');
    expect(content).toContain('[Install]');
    expect(content).toContain('{{PROJECT_ROOT}}');
    expect(content).toContain('{{NODE_BIN}}');
    expect(content).toContain('WantedBy=multi-user.target');
    // Must run as root (for nspawn without user namespace issues)
    expect(content).toContain('User=root');
  });

  it('has no Docker-specific patterns in the bootstrap script', () => {
    const bootstrapFile = path.join(
      skillDir,
      'add',
      'scripts',
      'nspawn-bootstrap.sh',
    );
    const content = fs.readFileSync(bootstrapFile, 'utf-8');

    // bootstrap uses docker export only as one strategy, but the overall file
    // should not assume Docker is always available
    expect(content).toContain('if command -v docker');
  });

  it('containerPreamble does not use --user= flag', () => {
    // The entrypoint.sh handles user switching via su, not nspawn's --user=
    const runtimeFile = path.join(
      skillDir,
      'modify',
      'src',
      'container-runtime.ts',
    );
    const content = fs.readFileSync(runtimeFile, 'utf-8');

    // containerPreamble function should not contain '--user='
    const preambleFnMatch = content.match(
      /function containerPreamble[\s\S]*?^}/m,
    );
    if (preambleFnMatch) {
      expect(preambleFnMatch[0]).not.toContain("'--user=");
    }
  });
});
