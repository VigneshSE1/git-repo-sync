import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDataDir } from './config';
import { normalizeRemote } from './remote';

export type TransferStatus =
  | 'in-progress'
  | 'conflict'
  | 'ready-for-review'
  | 'pushed'
  | 'pr-created'
  | 'aborted';

export interface TransferCommitRecord {
  sha: string;
  subject: string;
  result: 'pending' | 'applied' | 'skipped-empty' | 'conflict';
  newSha?: string;
}

export interface TransferRecord {
  key: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  internUrl: string;
  orgUrl: string;
  targetBranch: string;
  branch: string;
  strategy: 'cherry-pick' | 'patch';
  status: TransferStatus;
  originalBranch: string;
  baseSha: string;
  tip?: string;
  commits: TransferCommitRecord[];
  conflictFiles?: string[];
  patchMessage?: string;
  orgPrUrl?: string;
  orgPrNumber?: number;
  manualPrUrl?: string | null;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncRecord {
  phase: 'applied' | 'pushed';
  strategy: 'merge' | 'exact';
  branch: string;
  backupBranch: string;
  previousLocalSha: string;
  /** Remote branch tip at the time the sync was prepared (used as the push lease). */
  expectedRemoteSha: string;
  orgSha: string;
  appliedSha: string;
  needsForcePush: boolean;
  updatedAt: string;
}

export interface AppState {
  transfers: Record<string, TransferRecord>;
  sync?: SyncRecord;
  lastSyncAt?: string;
}

const stateFile = () => path.join(dataDir(), 'state.json');

export function loadState(): AppState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as AppState;
    return { ...parsed, transfers: parsed.transfers ?? {} };
  } catch {
    return { transfers: {} };
  }
}

function saveState(state: AppState): void {
  ensureDataDir();
  const tmp = `${stateFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, stateFile());
}

export function transferKey(internUrl: string, prNumber: number): string {
  return `${normalizeRemote(internUrl)}#${prNumber}`;
}

export function getTransfer(key: string): TransferRecord | undefined {
  return loadState().transfers[key];
}

export function putTransfer(rec: TransferRecord): TransferRecord {
  const state = loadState();
  const next = { ...rec, updatedAt: new Date().toISOString() };
  state.transfers[rec.key] = next;
  saveState(state);
  return next;
}

export function updateTransfer(key: string, patch: Partial<TransferRecord>): TransferRecord {
  const cur = loadState().transfers[key];
  if (!cur) throw new Error(`Unknown transfer ${key}`);
  return putTransfer({ ...cur, ...patch });
}

export function listTransfers(): TransferRecord[] {
  return Object.values(loadState().transfers).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getSyncRecord(): SyncRecord | undefined {
  return loadState().sync;
}

export function clearSyncRecord(): void {
  const state = loadState();
  delete state.sync;
  saveState(state);
}

export function putSyncRecord(rec: Omit<SyncRecord, 'updatedAt'>, extra: { lastSyncAt?: string } = {}): void {
  const state = loadState();
  state.sync = { ...rec, updatedAt: new Date().toISOString() };
  if (extra.lastSyncAt) state.lastSyncAt = extra.lastSyncAt;
  saveState(state);
}
