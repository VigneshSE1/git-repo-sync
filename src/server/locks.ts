import path from 'node:path';
import { AppError } from './errors';

const g = globalThis as unknown as { __grsLocks?: Map<string, string> };
const held = (g.__grsLocks ??= new Map<string, string>());

export function lockKey(p: string): string {
  const r = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Runs fn while holding exclusive locks on every repo path; fails fast if any is busy. */
export async function withRepoLocks<T>(paths: string[], operation: string, fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map(lockKey))];
  for (const k of keys) {
    const holder = held.get(k);
    if (holder) {
      throw new AppError('LOCKED', `Another operation is already running on this repository (${holder}).`, {
        hint: 'Wait for it to finish and retry.',
      });
    }
  }
  for (const k of keys) held.set(k, operation);
  try {
    return await fn();
  } finally {
    for (const k of keys) held.delete(k);
  }
}
