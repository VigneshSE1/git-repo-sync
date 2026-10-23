import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDataDir } from './config';
import { redact } from './redact';

export interface LogEntry {
  id: number;
  ts: string;
  scope: string;
  kind: 'git' | 'api' | 'info' | 'error';
  message: string;
  ok?: boolean;
  durationMs?: number;
  output?: string;
}

interface LogStore {
  seq: number;
  entries: LogEntry[];
}
const g = globalThis as unknown as { __grsLog?: LogStore };
const store: LogStore = (g.__grsLog ??= { seq: 0, entries: [] });
const MAX = 1000;

export function logEvent(e: Omit<LogEntry, 'id' | 'ts'>): LogEntry {
  const entry: LogEntry = {
    ...e,
    id: ++store.seq,
    ts: new Date().toISOString(),
    message: redact(e.message),
    output: e.output ? redact(e.output).slice(0, 2000) : undefined,
  };
  store.entries.push(entry);
  if (store.entries.length > MAX) store.entries.splice(0, store.entries.length - MAX);
  try {
    ensureDataDir();
    fs.appendFileSync(path.join(dataDir(), 'operations.log'), JSON.stringify(entry) + '\n');
  } catch {
    /* logging must never break an operation */
  }
  return entry;
}

export function getLog(limit = 200): LogEntry[] {
  return store.entries.slice(-limit);
}

export function clearLog(): void {
  store.entries.length = 0;
}
