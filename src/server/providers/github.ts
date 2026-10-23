import { AppError } from '../errors';
import { logEvent } from '../log';
import { parseSlug } from '../remote';
import type {
  CreatedPullRequest,
  CreatePullRequestInput,
  GitProvider,
  ProviderCommit,
  ProviderFile,
  PullRequestSummary,
  RemoteRepo,
} from './types';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface GhPull {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  merged_at?: string | null;
  created_at?: string;
  user?: { login?: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  commits?: number;
}

const PAGE = 100;
const MAX_PAGES = 10;

export class GitHubProvider implements GitProvider {
  readonly kind = 'github' as const;
  readonly capabilities: { listPullRequests: boolean; createPullRequest: boolean };

  constructor(
    private readonly token: string | undefined,
    private readonly apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {
    this.capabilities = { listPullRequests: !!token, createPullRequest: !!token };
  }

  private slug(repo: RemoteRepo): { owner: string; repo: string } {
    const s = parseSlug(repo.url);
    if (!s) {
      throw new AppError('PROVIDER', `Cannot derive a GitHub owner/repo from ${repo.url}.`, {
        hint: 'Use an https://github.com/owner/repo or git@github.com:owner/repo URL.',
      });
    }
    return { owner: s.owner, repo: s.repo };
  }

  private async request<T>(method: string, pathName: string, body?: unknown): Promise<T> {
    if (!this.token) {
      throw new AppError('AUTH', 'No GitHub token is configured on the server.', {
        hint: 'Set GITHUB_TOKEN_INTERN / GITHUB_TOKEN_ORG (or GITHUB_TOKEN) in .env.local and restart the dev server.',
      });
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUrl}${pathName}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'git-repo-sync',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      logEvent({ scope: 'github', kind: 'api', message: `${method} ${pathName}`, ok: false, durationMs: Date.now() - started, output: String(e) });
      throw new AppError('NETWORK', 'Could not reach the GitHub API.', { hint: 'Check your network/proxy and GITHUB_API_URL.', cause: e });
    }
    logEvent({ scope: 'github', kind: 'api', message: `${method} ${pathName} -> ${res.status}`, ok: res.ok, durationMs: Date.now() - started });
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as T;
  }

  private async toError(res: Response): Promise<AppError> {
    let detail = '';
    try {
      const j = (await res.json()) as { message?: string; errors?: Array<{ message?: string }> };
      detail = [j.message, ...(j.errors?.map((e) => e.message) ?? [])].filter(Boolean).join('; ');
    } catch {
      /* non-JSON error body */
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 401) {
      return new AppError('AUTH', 'GitHub rejected the token (401).', {
        hint: 'The token is invalid or expired. Generate a new fine-grained token and update .env.local.',
      });
    }
    if (res.status === 403 && remaining === '0') {
      return new AppError('PROVIDER', 'GitHub API rate limit exceeded.', { hint: 'Wait until the limit resets, or use an authenticated token.' });
    }
    if (res.status === 403) {
      return new AppError('AUTH', `GitHub denied access (403)${detail ? `: ${detail}` : ''}.`, {
        hint: 'The token lacks permission on this repository (needs Pull requests and Contents access; SSO-protected orgs require authorizing the token).',
      });
    }
    if (res.status === 404) {
      return new AppError('NOT_FOUND', 'GitHub resource not found (404).', {
        hint: 'Check the repository URL and that the token can see this (possibly private) repository.',
      });
    }
    if (res.status === 422) {
      return new AppError('PROVIDER', `GitHub rejected the request (422)${detail ? `: ${detail}` : ''}.`, {
        hint: 'A pull request for this branch may already exist, or the branch has no differences from the base.',
      });
    }
    return new AppError('PROVIDER', `GitHub API error ${res.status}${detail ? `: ${detail}` : ''}.`);
  }

  private async paged<T>(pathName: string): Promise<T[]> {
    const out: T[] = [];
    const sep = pathName.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await this.request<T[]>('GET', `${pathName}${sep}per_page=${PAGE}&page=${page}`);
      out.push(...items);
      if (items.length < PAGE) break;
    }
    return out;
  }

  private map(p: GhPull): PullRequestSummary {
    return {
      number: p.number,
      title: p.title,
      author: p.user?.login ?? 'unknown',
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      state: p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed',
      url: p.html_url,
      commitCount: p.commits ?? 0,
      headSha: p.head.sha,
      baseSha: p.base.sha,
      createdAt: p.created_at,
      mergedAt: p.merged_at ?? null,
    };
  }

  async listPullRequests(repo: RemoteRepo, filter: 'open' | 'merged' | 'all'): Promise<PullRequestSummary[]> {
    const { owner, repo: name } = this.slug(repo);
    const state = filter === 'open' ? 'open' : 'all';
    const raw = await this.paged<GhPull>(`/repos/${owner}/${name}/pulls?state=${state}&sort=updated&direction=desc`);
    return raw
      .map((p) => this.map(p))
      .filter((p) => (filter === 'merged' ? p.state === 'merged' : filter === 'open' ? p.state === 'open' : p.state !== 'closed'));
  }

  async getPullRequest(repo: RemoteRepo, number: number): Promise<PullRequestSummary> {
    const { owner, repo: name } = this.slug(repo);
    return this.map(await this.request<GhPull>('GET', `/repos/${owner}/${name}/pulls/${number}`));
  }

  async listPullRequestCommits(repo: RemoteRepo, number: number): Promise<ProviderCommit[]> {
    const { owner, repo: name } = this.slug(repo);
    const raw = await this.paged<{ sha: string; commit: { message: string; author?: { name?: string } }; author?: { login?: string } | null }>(
      `/repos/${owner}/${name}/pulls/${number}/commits`,
    );
    return raw.map((c) => ({
      sha: c.sha,
      subject: c.commit.message.split('\n')[0],
      author: c.author?.login ?? c.commit.author?.name ?? 'unknown',
    }));
  }

  async listPullRequestFiles(repo: RemoteRepo, number: number): Promise<ProviderFile[]> {
    const { owner, repo: name } = this.slug(repo);
    const raw = await this.paged<{ filename: string; status: string; additions: number; deletions: number }>(
      `/repos/${owner}/${name}/pulls/${number}/files`,
    );
    return raw.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
  }

  pullRequestHeadRef(pr: PullRequestSummary): string {
    return `refs/pull/${pr.number}/head`;
  }

  async findOpenPullRequest(repo: RemoteRepo, head: string, base: string): Promise<CreatedPullRequest | null> {
    const { owner, repo: name } = this.slug(repo);
    const list = await this.request<GhPull[]>(
      'GET',
      `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`,
    );
    return list[0] ? { number: list[0].number, url: list[0].html_url } : null;
  }

  async createPullRequest(repo: RemoteRepo, input: CreatePullRequestInput): Promise<CreatedPullRequest> {
    const { owner, repo: name } = this.slug(repo);
    const created = await this.request<GhPull>('POST', `/repos/${owner}/${name}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      maintainer_can_modify: true,
    });
    return { number: created.number, url: created.html_url };
  }

  manualCompareUrl(repo: RemoteRepo, head: string, base: string): string | null {
    const s = parseSlug(repo.url);
    if (!s) return null;
    return `https://${s.host}/${s.owner}/${s.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
  }
}
