# Intent: src/container-runner.ts modifications

## What changed
Targeted edits only — the vast majority of this file is unchanged. Two modifications:

## 1. Import changes

### Removed from `./config.js` imports:
- `CONTAINER_IMAGE` — no longer needed; nspawn uses a rootfs directory, not an image name
- `TIMEZONE` — moved into `container-runtime.ts`'s `containerPreamble()`, which imports it directly

### Added to `./container-runtime.js` imports:
- `writableMountArgs` — replaces the hardcoded `'-v', 'host:container'` for writable mounts
- `containerPreamble` — replaces `['run', '-i', '--rm', '--name', name, '-e', 'TZ=...', '--user', ...]`
- `containerSuffix` — replaces `[CONTAINER_IMAGE]` at the end of the args array

## 2. buildContainerArgs function

### Removed:
```typescript
const args: string[] = ['run', '-i', '--rm', '--name', containerName];
args.push('-e', `TZ=${TIMEZONE}`);
const hostUid = process.getuid?.();
const hostGid = process.getgid?.();
if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
  args.push('--user', `${hostUid}:${hostGid}`);
  args.push('-e', 'HOME=/home/node');
}
// ...
args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
// ...
args.push(CONTAINER_IMAGE);
```

### Added:
```typescript
const args: string[] = [...containerPreamble(containerName)];
// ...
args.push(...writableMountArgs(mount.hostPath, mount.containerPath));
// ...
args.push(...containerSuffix());
```

## Invariants
- The function signature `buildContainerArgs(mounts, containerName): string[]` is unchanged
- The mount loop structure (readonly vs writable) is unchanged
- All logging, streaming, IPC, and timeout logic is completely untouched
- The VolumeMount interface is unchanged
- All other functions in container-runner.ts are unchanged

## Must-keep
- The `for (const mount of mounts)` loop with `mount.readonly` check
- The import of `readonlyMountArgs` and `stopContainer` from container-runtime.ts (already there)
- All other imports from config.ts (`CONTAINER_MAX_OUTPUT_SIZE`, `CONTAINER_TIMEOUT`, etc.)
