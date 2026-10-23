import os from 'node:os';
import { authStatus } from './config';
import { AppError } from './errors';
import { GitRepo, validateRepo, type CommitSummary } from './git/repo';
import { redact } from './redact';
import { listTransfers, loadState } from './state';
import type { AppConfig, RepoConfig } from './validation';

export interface RepoStatus {
  role: 'org' | 'intern';
  url: string;
  path: string;
  provider: string;
  branch: string;
  valid: boolean;
  error?: { code: string; message: string; hint?: string };
  currentBranch?: string;
  clean?: boolean;
  trackedChanges?: number;
  untracked?: number;
  latest?: CommitSummary | null;
  /** Local branch vs its remote-tracking ref. */
  localVsRemote?: { ahead: number; behind: number } | null;
}

export interface Comparison {
  /** Commits only on intern. */
  aheadOfOrg: number;
  /** Commits only on org (intern is missing them). */
  behindOrg: number;
  orgSha: string;
  internSha: string;
  unrelated: boolean;
}

export async function repoStatus(role: 'org' | 'intern', cfg: RepoConfig): Promise<RepoStatus> {
  const base: RepoStatus = { role, url: cfg.url, path: cfg.path, provider: cfg.provider, branch: cfg.branch, valid: false };
  try {
    const v = await validateRepo(cfg, role, {});
    const st = await v.repo.status();
    const remoteRef = `refs/remotes/${v.remote}/${cfg.branch}`;
    const latest = await v.repo.commitInfo(remoteRef);
    let localVsRemote: RepoStatus['localVsRemote'] = null;
    if (latest && (await v.repo.branchExists(cfg.branch))) {
      const lr = await v.repo.leftRight(`refs/heads/${cfg.branch}`, remoteRef);
      localVsRemote = { ahead: lr.left, behind: lr.right };
    }
    return {
      ...base,
      valid: true,
      currentBranch: v.currentBranch,
      clean: st.clean,
      trackedChanges: st.tracked.length,
      untracked: st.untracked.length,
      latest,
      localVsRemote,
    };
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError('GIT', e instanceof Error ? e.message : String(e));
    return { ...base, error: { code: err.code, message: redact(err.message), hint: err.hint } };
  }
}

export async function compareBranches(cfg: AppConfig): Promise<Comparison | null> {
  try {
    const v = await validateRepo(cfg.intern, 'intern', {});
    const orgRef = `refs/sync/org/${cfg.org.branch}`;
    const internSha = await v.repo.resolve(`refs/remotes/${v.remote}/${cfg.intern.branch}`);
    const orgSha = await v.repo.resolve(orgRef);
    if (!internSha || !orgSha) return null;
    const base = await v.repo.mergeBase(internSha, orgSha);
    if (!base) return { aheadOfOrg: 0, behindOrg: 0, orgSha, internSha, unrelated: true };
    const lr = await v.repo.leftRight(internSha, orgSha);
    return { aheadOfOrg: lr.left, behindOrg: lr.right, orgSha, internSha, unrelated: false };
  } catch {
    return null;
  }
}

/** Fetches both remotes (read-only) so the dashboard shows current data. */
export async function fetchBoth(cfg: AppConfig): Promise<void> {
  const org = await validateRepo(cfg.org, 'org', {});
  const intern = await validateRepo(cfg.intern, 'intern', {});
  await org.repo.fetchRemote(org.remote);
  await intern.repo.fetchRemote(intern.remote);
  await intern.repo.fetchFromUrl(cfg.org.url, `refs/heads/${cfg.org.branch}`, `refs/sync/org/${cfg.org.branch}`);
}

export async function dashboardStatus(cfg: AppConfig, opts: { fetch: boolean }) {
  let fetchError: { code: string; message: string; hint?: string } | undefined;
  if (opts.fetch) {
    try {
      await fetchBoth(cfg);
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError('GIT', String(e));
      fetchError = { code: err.code, message: redact(err.message), hint: err.hint };
    }
  }
  const [org, intern] = await Promise.all([repoStatus('org', cfg.org), repoStatus('intern', cfg.intern)]);
  const state = loadState();
  return {
    org,
    intern,
    comparison: intern.valid ? await compareBranches(cfg) : null,
    lastSyncAt: state.lastSyncAt ?? null,
    sync: state.sync ?? null,
    transfers: listTransfers().map((t) => ({
      prNumber: t.prNumber,
      title: t.prTitle,
      status: t.status,
      branch: t.branch,
      orgPrUrl: t.orgPrUrl ?? null,
      updatedAt: t.updatedAt,
    })),
    fetchedAt: opts.fetch ? new Date().toISOString() : null,
    fetchError,
    auth: authStatus(),
  };
}

export type DashboardStatus = Awaited<ReturnType<typeof dashboardStatus>>;

/** Read-only check that the user's existing Git credentials can reach a remote. */
export async function checkGitAuth(url: string, branch: string): Promise<{ ok: boolean; sha?: string | null; error?: { code: string; message: string; hint?: string } }> {
  try {
    const sha = await new GitRepo(os.tmpdir(), 'auth-check').lsRemoteHead(url, branch);
    return { ok: true, sha };
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError('GIT', String(e));
    return { ok: false, error: { code: err.code, message: redact(err.message), hint: err.hint } };
  }
}
