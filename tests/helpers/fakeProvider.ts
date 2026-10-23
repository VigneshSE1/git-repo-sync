import { AppError } from '@/server/errors';
import type {
  CreatedPullRequest,
  CreatePullRequestInput,
  GitProvider,
  ProviderCommit,
  ProviderFile,
  PullRequestSummary,
} from '@/server/providers/types';

export interface FakePr {
  summary: PullRequestSummary;
  commits: ProviderCommit[];
  files: ProviderFile[];
}

/** In-memory provider; the "PR head" is just a branch in the (local) intern remote. */
export class FakeProvider implements GitProvider {
  readonly kind = 'github' as const;
  capabilities = { listPullRequests: true, createPullRequest: true };
  prs = new Map<number, FakePr>();
  created: CreatePullRequestInput[] = [];
  existingOpen: CreatedPullRequest | null = null;
  failCreate: AppError | null = null;

  add(pr: FakePr): void {
    this.prs.set(pr.summary.number, pr);
  }

  private get(n: number): FakePr {
    const pr = this.prs.get(n);
    if (!pr) throw new AppError('NOT_FOUND', `PR ${n} not found`);
    return pr;
  }

  async listPullRequests(_r: unknown, filter: 'open' | 'merged' | 'all') {
    return [...this.prs.values()].map((p) => p.summary).filter((s) => filter === 'all' || s.state === filter);
  }
  async getPullRequest(_r: unknown, n: number) {
    return this.get(n).summary;
  }
  async listPullRequestCommits(_r: unknown, n: number) {
    return this.get(n).commits;
  }
  async listPullRequestFiles(_r: unknown, n: number) {
    return this.get(n).files;
  }
  pullRequestHeadRef(pr: PullRequestSummary) {
    return `refs/heads/${pr.sourceBranch}`;
  }
  async findOpenPullRequest() {
    return this.existingOpen;
  }
  async createPullRequest(_r: unknown, input: CreatePullRequestInput): Promise<CreatedPullRequest> {
    if (this.failCreate) throw this.failCreate;
    this.created.push(input);
    return { number: 100 + this.created.length, url: `https://example.test/org/repo/pull/${100 + this.created.length}` };
  }
  manualCompareUrl(_r: unknown, head: string, base: string) {
    return `https://example.test/org/repo/compare/${base}...${head}`;
  }
}
