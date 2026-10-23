// Type-only imports: erased at build time, so no server code reaches the browser bundle.
import type { AppConfig } from '@/server/validation';
import type { DashboardStatus } from '@/server/status';
import type { LogEntry } from '@/server/log';
import type { SyncApplyResult, SyncPreview } from '@/server/workflows/sync';
import type { PublishResult, TransferOutcome, TransferPlan, TransferReview } from '@/server/workflows/transfer';
import type { PullRequestSummary } from '@/server/providers/types';
import type { TransferRecord } from '@/server/state';

export type {
  AppConfig,
  DashboardStatus,
  LogEntry,
  SyncApplyResult,
  SyncPreview,
  PublishResult,
  TransferOutcome,
  TransferPlan,
  TransferReview,
  PullRequestSummary,
  TransferRecord,
};

export interface ConfigResponse {
  configured: boolean;
  config: AppConfig | null;
  auth: { org: { tokenConfigured: boolean; source: string | null }; intern: { tokenConfigured: boolean; source: string | null } };
}

export type PrRow = PullRequestSummary & { transfer: TransferRecord['status'] | null };

export interface ValidateResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  latest: { sha: string; subject: string; author: string; date: string } | null;
}

export type Tab = 'dashboard' | 'sync' | 'transfer' | 'setup' | 'log';
