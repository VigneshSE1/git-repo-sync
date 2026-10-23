import { AppError } from '../errors';
import type { GitRepo } from '../git/repo';
import type {
  CreatedPullRequest,
  GitProvider,
  ProviderCommit,
  ProviderFile,
  PullRequestSummary,
  RemoteRepo,
} from './types';

/**
 * Demo/offline provider: treats every non-target branch of a local intern repo as a "PR".
 * It cannot create pull requests (and never pretends to) - the transfer branch is pushed and the
 * user is told to open the PR by hand.
 */
export class LocalDemoProvider implements GitProvider {
  readonly kind = 'local' as const;
  readonly capabilities = { listPullRequests: true, createPullRequest: false };

  constructor(
    private readonly repo: GitRepo,
    private readonly remote: string,
    private readonly targetBranch: string,
  ) {}

  private async branches(): Promise<string[]> {
    const prefix = `refs/remotes/${this.remote}/`;
    const out = (await this.repo.run(['for-each-ref', '--format=%(refname)', prefix])).out;
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((ref) => ref.startsWith(prefix) && !ref.endsWith('/HEAD')) // skip the symbolic origin/HEAD
      .map((ref) => ref.slice(prefix.length))
      .filter((b) => b !== this.targetBranch)
      .sort();
  }

  private async summarize(branch: string, number: number): Promise<PullRequestSummary> {
    const head = (await this.repo.resolve(`refs/remotes/${this.remote}/${branch}`)) ?? '';
    const target = `refs/remotes/${this.remote}/${this.targetBranch}`;
    const commits = await this.repo.log(`${target}..${head}`, 500);
    return {
      number,
      title: commits[commits.length - 1]?.subject ?? branch,
      author: commits[0]?.author ?? 'unknown',
      sourceBranch: branch,
      targetBranch: this.targetBranch,
      state: 'open',
      url: `local:${branch}`,
      commitCount: commits.length,
      headSha: head,
      baseSha: (await this.repo.resolve(target)) ?? undefined,
    };
  }

  async listPullRequests(): Promise<PullRequestSummary[]> {
    const list = await this.branches();
    return Promise.all(list.map((b, i) => this.summarize(b, i + 1)));
  }

  async getPullRequest(_repo: RemoteRepo, number: number): Promise<PullRequestSummary> {
    const list = await this.branches();
    const branch = list[number - 1];
    if (!branch) throw new AppError('NOT_FOUND', `No demo PR #${number}.`);
    return this.summarize(branch, number);
  }

  async listPullRequestCommits(_repo: RemoteRepo, number: number): Promise<ProviderCommit[]> {
    const pr = await this.getPullRequest({ url: '' }, number);
    const range = `refs/remotes/${this.remote}/${this.targetBranch}..${pr.headSha}`;
    const out = (await this.repo.run(['log', '--reverse', '--topo-order', '--format=%H%x1f%an%x1f%s', range])).out;
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [sha, author, subject] = l.split('\x1f');
        return { sha, author, subject };
      });
  }

  async listPullRequestFiles(_repo: RemoteRepo, number: number): Promise<ProviderFile[]> {
    const pr = await this.getPullRequest({ url: '' }, number);
    const files = await this.repo.diffFiles(`refs/remotes/${this.remote}/${this.targetBranch}...${pr.headSha}`);
    return files.map((f) => ({ path: f.path, status: f.status, additions: 0, deletions: 0 }));
  }

  pullRequestHeadRef(pr: PullRequestSummary): string {
    return `refs/heads/${pr.sourceBranch}`;
  }

  async findOpenPullRequest(): Promise<CreatedPullRequest | null> {
    return null;
  }

  async createPullRequest(): Promise<CreatedPullRequest> {
    throw new AppError('UNSUPPORTED', 'The local demo provider cannot create pull requests.', {
      hint: 'The branch was pushed; open a PR with your hosting provider.',
    });
  }

  manualCompareUrl(): string | null {
    return null;
  }
}
