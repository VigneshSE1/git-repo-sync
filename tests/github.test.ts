import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import { GitHubProvider, type FetchLike } from '@/server/providers/github';
import { createProvider } from '@/server/providers';

const repo = { url: 'https://github.com/acme/widgets.git' };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function provider(handler: FetchLike, token: string | null = 'tok_test_123456') {
  return new GitHubProvider(token ?? undefined, 'https://api.example.test', handler);
}

const pull = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `PR ${n}`,
  html_url: `https://github.com/acme/widgets/pull/${n}`,
  state: 'open',
  merged_at: null,
  user: { login: 'intern' },
  head: { ref: `feature/${n}`, sha: 'a'.repeat(40) },
  base: { ref: 'develop', sha: 'b'.repeat(40) },
  commits: 2,
  ...extra,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).code;
}

describe('GitHub provider', () => {
  it('lists open and merged PRs with state mapping and bearer auth', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const p = provider(async (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return json([pull(1), pull(2, { state: 'closed', merged_at: '2024-01-01T00:00:00Z' }), pull(3, { state: 'closed' })]);
    });
    const open = await p.listPullRequests(repo, 'open');
    expect(open.map((x) => x.number)).toEqual([1]);
    const merged = await p.listPullRequests(repo, 'merged');
    expect(merged.map((x) => [x.number, x.state])).toEqual([[2, 'merged']]);
    const all = await p.listPullRequests(repo, 'all');
    expect(all.map((x) => x.number)).toEqual([1, 2]); // closed-unmerged excluded
    expect(seen[0].url).toContain('/repos/acme/widgets/pulls?state=open');
    expect(seen[0].auth).toBe('Bearer tok_test_123456');
    expect(open[0]).toMatchObject({ author: 'intern', sourceBranch: 'feature/1', targetBranch: 'develop', commitCount: 2 });
  });

  it('maps API failures to actionable error codes', async () => {
    const mk = (res: () => Response | Promise<Response>) => provider(async () => res());
    expect(await codeOf(mk(() => json({ message: 'Bad credentials' }, { status: 401 })).getPullRequest(repo, 1))).toBe('AUTH');
    expect(await codeOf(mk(() => json({ message: 'Resource not accessible' }, { status: 403 })).getPullRequest(repo, 1))).toBe('AUTH');
    expect(
      await codeOf(mk(() => json({ message: 'rate limited' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })).getPullRequest(repo, 1)),
    ).toBe('PROVIDER');
    expect(await codeOf(mk(() => json({ message: 'Not Found' }, { status: 404 })).getPullRequest(repo, 1))).toBe('NOT_FOUND');
    expect(await codeOf(mk(() => json({ message: 'boom' }, { status: 500 })).getPullRequest(repo, 1))).toBe('PROVIDER');
    expect(await codeOf(mk(() => Promise.reject(new TypeError('fetch failed'))).getPullRequest(repo, 1))).toBe('NETWORK');
  });

  it('fails clearly without a token and never calls the network', async () => {
    let called = false;
    const p = provider(async () => {
      called = true;
      return json([]);
    }, null);
    expect(p.capabilities).toEqual({ listPullRequests: false, createPullRequest: false });
    expect(await codeOf(p.listPullRequests(repo, 'open'))).toBe('AUTH');
    expect(called).toBe(false);
  });

  it('rejects non-GitHub style remotes', async () => {
    const p = provider(async () => json([]));
    expect(await codeOf(p.listPullRequests({ url: '/some/local/path' }, 'open'))).toBe('PROVIDER');
  });

  it('creates a PR with the expected payload and surfaces a 422 duplicate', async () => {
    let body: Record<string, unknown> = {};
    const ok = provider(async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return json(pull(9), { status: 201 });
    });
    const created = await ok.createPullRequest(repo, { title: 'T', body: 'B', head: 'sync/intern-pr-1', base: 'develop' });
    expect(created).toEqual({ number: 9, url: 'https://github.com/acme/widgets/pull/9' });
    expect(body).toMatchObject({ title: 'T', body: 'B', head: 'sync/intern-pr-1', base: 'develop' });

    const dup = provider(async () => json({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] }, { status: 422 }));
    const err = (await dup.createPullRequest(repo, { title: 'T', body: 'B', head: 'x', base: 'develop' }).then(() => null, (e) => e)) as AppError;
    expect(err.code).toBe('PROVIDER');
    expect(err.message).toContain('already exists');
  });

  it('paginates and exposes the PR head ref and a manual compare link', async () => {
    const pages: number[] = [];
    const p = provider(async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      const count = page === 1 ? 100 : 5;
      return json(Array.from({ length: count }, (_, i) => ({ sha: `${page}-${i}`.padEnd(40, '0'), commit: { message: `m${i}\nbody` }, author: { login: 'u' } })));
    });
    const commits = await p.listPullRequestCommits(repo, 5);
    expect(commits).toHaveLength(105);
    expect(pages).toEqual([1, 2]);
    expect(commits[0].subject).toBe('m0');
    expect(p.pullRequestHeadRef({ number: 5 } as never)).toBe('refs/pull/5/head');
    expect(p.manualCompareUrl(repo, 'sync/intern-pr-5', 'develop')).toBe(
      'https://github.com/acme/widgets/compare/develop...sync%2Fintern-pr-5?expand=1',
    );
  });
});

describe('provider registry', () => {
  it('reports unsupported providers instead of pretending', () => {
    expect(() => createProvider({ role: 'org', kind: 'azure-devops' })).toThrowError(/no PR API integration/);
    expect(() => createProvider({ role: 'org', kind: 'other' })).toThrowError(AppError);
  });
});
