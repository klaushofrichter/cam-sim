import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname } from 'path';

// Atomic JSON write: a temp file with a random suffix in the same directory,
// fsync, then rename over the target. A crash leaves the old file or the new
// one, never half of either.
export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value));
}

// `sync: false` skips the fsync, for files rewritten every second that
// don't have to survive a crash (the SD pipeline's clock).
export function writeFileAtomic(file: string, text: string, opts: { sync?: boolean } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, text);
      if (opts.sync !== false) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    // A failed write (a full disk) leaves no temp file behind.
    rmSync(tmp, { force: true });
    throw err;
  }
}

// undefined when the file doesn't exist; throws on unreadable or invalid JSON.
export function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return JSON.parse(text);
}

export const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// Deep merge of `patch` into `target`, skipping prototype keys.
export function deepMerge(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isObject(v) && isObject(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = clone(v);
    }
  }
  return target;
}

export function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
