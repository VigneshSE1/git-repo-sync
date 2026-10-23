import type { ProviderKind } from '../validation';

export type PrState = 'open' | 'merged' | 'closed';

export interface PullRequestSummary {
  number: number;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  state: PrState;
  url: string;
  commitCount: number;
  headSha: string;
  /** Base commit recorded by the provider (may be absent). */
  baseSha?: string;
  createdAt?: string;
  mergedAt?: string | null;
}

export interface ProviderCommit {
  sha: string;
  subject: string;
  author: string;
}

export interface ProviderFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface CreatedPullRequest {
  number: number;
  url: string;
}

/** A hosted repository the provider operates on. */
export interface RemoteRepo {
  url: string;
}

/**
 * Hosting-provider abstraction. GitHub is implemented; Azure DevOps can be added by
 * implementing this interface and registering it in `providers/index.ts`.
 */
export interface GitProvider {
  readonly kind: ProviderKind;
  /** Whether the provider can create PRs / list PRs right now (e.g. token present). */
  readonly capabilities: { listPullRequests: boolean; createPullRequest: boolean };
  listPullRequests(repo: RemoteRepo, filter: 'open' | 'merged' | 'all'): Promise<PullRequestSummary[]>;
  getPullRequest(repo: RemoteRepo, number: number): Promise<PullRequestSummary>;
  listPullRequestCommits(repo: RemoteRepo, number: number): Promise<ProviderCommit[]>;
  listPullRequestFiles(repo: RemoteRepo, number: number): Promise<ProviderFile[]>;
  /** Git ref (on the PR's repository) that always points to the PR head, e.g. refs/pull/N/head. */
  pullRequestHeadRef(pr: PullRequestSummary): string;
  findOpenPullRequest(repo: RemoteRepo, head: string, base: string): Promise<CreatedPullRequest | null>;
  createPullRequest(repo: RemoteRepo, input: CreatePullRequestInput): Promise<CreatedPullRequest>;
  /** Link a human can open to create the PR manually when the API is unavailable. */
  manualCompareUrl(repo: RemoteRepo, head: string, base: string): string | null;
}
