import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import { getTransfer, transferKey } from '@/server/state';
import {
  planTransfer,
  publishTransfer,
  resumeTransfer,
  reviewTransfer,
  startTransfer,
  type TransferContext,
} from '@/server/workflows/transfer';
import { FakeProvider } from './helpers/fakeProvider';
import { commitFile, git, makeScenario, write, type Scenario } from './helpers/repos';

let sc: Scenario;
let fake: FakeProvider;
beforeEach(() => {
  sc = makeScenario();
  fake = new FakeProvider();
});
afterEach(() => sc.cleanup());

const ctx = (previewOnly = false): TransferContext => ({
  org: { path: sc.orgClone, url: sc.orgBare, branch: 'develop' },
  intern: { path: sc.internClone, url: sc.internBare, branch: 'develop' },
  internProvider: fake,
  orgProvider: fake,
  previewOnly,
});

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err, `expected AppError ${code}, got ${String(err)}`).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

/** Creates feature branch commits in the intern remote and registers the matching fake PR. */
function makePr(
  number: number,
  branch: string,
  commits: Array<[file: string, content: string, message: string]>,
  opts: { from?: string; baseSha?: string; state?: 'open' | 'merged' } = {},
) {
  const dev = sc.internDev;
  git(dev, 'fetch', 'origin');
  git(dev, 'switch', '-C', branch, opts.from ?? 'origin/develop');
  const shas = commits.map(([f, c, m]) => commitFile(dev, f, c, m));
  git(dev, 'push', '--force', 'origin', branch);
  const head = git(dev, 'rev-parse', 'HEAD');
  git(dev, 'switch', 'develop');
  syncFake(number, branch, shas, head, opts);
  return { shas, head };
}

function syncFake(number: number, branch: string, shas: string[], head: string, opts: { baseSha?: string; state?: 'open' | 'merged' } = {}) {
  fake.add({
    summary: {
      number,
      title: `Intern feature ${number}`,
      author: 'intern-dev',
      sourceBranch: branch,
      targetBranch: 'develop',
      state: opts.state ?? 'open',
      url: `https://example.test/intern/repo/pull/${number}`,
      commitCount: shas.length,
      headSha: head,
      baseSha: opts.baseSha ?? sc.seedSha,
    },
    commits: shas.map((sha) => ({ sha, subject: git(sc.internDev, 'log', '-1', '--format=%s', sha), author: 'intern-dev' })),
    files: [],
  });
}

const orgDevelopSha = () => git(sc.orgBare, 'rev-parse', 'develop');

describe('plan', () => {
  it('lists commits in PR order and marks them ready', async () => {
    makePr(1, 'feature/a', [
      ['a.txt', 'A\n', 'feat: add a'],
      ['b.txt', 'B\n', 'feat: add b'],
    ]);
    sc.advance('org', 'org-only.txt', 'x\n', 'org moves on');
    const plan = await planTransfer(ctx(), { prNumber: 1 });
    expect(plan.commits.map((c) => [c.subject, c.status])).toEqual([
      ['feat: add a', 'ready'],
      ['feat: add b', 'ready'],
    ]);
    expect(plan.recommendedStrategy).toBe('cherry-pick');
    expect(plan.branchName).toBe('sync/intern-pr-1');
    expect(plan.commits[0].files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('detects commits already in org and patch-equivalent commits', async () => {
    const { shas } = makePr(1, 'feature/a', [
      ['a.txt', 'A\n', 'feat: add a'],
      ['b.txt', 'B\n', 'feat: add b'],
      ['c.txt', 'C\n', 'feat: add c'],
    ]);
    // org fast-forwards to commit 1 (same SHA present in org)
    git(sc.orgDev, 'fetch', sc.internBare, 'feature/a');
    git(sc.orgDev, 'merge', '--ff-only', shas[0]);
    git(sc.orgDev, 'push', 'origin', 'develop');
    // org cherry-picks commit 2 on a different parent (new SHA, same patch)
    commitFile(sc.orgDev, 'unrelated.txt', 'u\n', 'org unrelated');
    git(sc.orgDev, 'cherry-pick', shas[1]);
    git(sc.orgDev, 'push', 'origin', 'develop');

    const plan = await planTransfer(ctx(), { prNumber: 1 });
    expect(plan.commits.map((c) => c.status)).toEqual(['already-in-org', 'equivalent-in-org', 'ready']);
    expect(plan.commits.filter((c) => c.selectable).map((c) => c.sha)).toEqual([shas[2]]);

    // selecting an already-applied commit is refused rather than silently ignored
    await expectCode(startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: [shas[0], shas[2]] }), 'PRECONDITION');
    expect(git(sc.orgClone, 'branch', '--list', 'sync/*')).toBe('');
  });

  it('flags merge commits and recommends the patch strategy', async () => {
    const first = makePr(1, 'feature/m', [['a.txt', 'A\n', 'feat: add a']]);
    sc.advance('intern', 'intern-dev-change.txt', 'd\n', 'intern develop moves');
    const dev = sc.internDev;
    git(dev, 'switch', 'feature/m');
    git(dev, 'fetch', 'origin');
    git(dev, 'merge', '--no-ff', '-m', 'Merge develop into feature', 'origin/develop');
    const mergeSha = git(dev, 'rev-parse', 'HEAD');
    const last = commitFile(dev, 'z.txt', 'Z\n', 'feat: add z');
    git(dev, 'push', 'origin', 'feature/m');
    const develop = git(dev, 'rev-parse', 'origin/develop');
    git(dev, 'switch', 'develop');
    syncFake(1, 'feature/m', [first.shas[0], mergeSha, last], last, { baseSha: develop });

    const plan = await planTransfer(ctx(), { prNumber: 1 });
    expect(plan.commits.map((c) => c.status)).toEqual(['ready', 'merge', 'ready']);
    expect(plan.recommendedStrategy).toBe('patch');
    expect(plan.strategyReasons.join(' ')).toMatch(/merge/i);

    await expectCode(startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: [mergeSha] }), 'PRECONDITION');

    // reviewed patch-based transfer works and does not drag in unrelated intern develop changes
    const out = await startTransfer(ctx(), { prNumber: 1, strategy: 'patch', commits: [] });
    expect(out.status).toBe('ready-for-review');
    const files = git(sc.orgClone, 'diff', '--name-only', 'origin/develop', 'HEAD').split('\n').sort();
    expect(files).toEqual(['a.txt', 'z.txt']);
    expect(git(sc.orgClone, 'rev-list', '--count', 'origin/develop..HEAD')).toBe('1');
    expect(git(sc.orgClone, 'log', '-1', '--format=%B')).toContain('Original PR: https://example.test/intern/repo/pull/1');
  });

  it('handles rebased commits whose SHAs changed (stale provider list) via the patch strategy', async () => {
    const orig = makePr(1, 'feature/r', [
      ['a.txt', 'A\n', 'feat: add a'],
      ['b.txt', 'B\n', 'feat: add b'],
    ]);
    await planTransfer(ctx(), { prNumber: 1 }); // fetches the original head into the org clone

    // intern develop advances, PR is rebased onto it and force-pushed
    sc.advance('intern', 'intern-only.txt', 'i\n', 'intern develop moves');
    const dev = sc.internDev;
    git(dev, 'switch', 'feature/r');
    git(dev, 'fetch', 'origin');
    git(dev, 'rebase', 'origin/develop');
    git(dev, 'push', '--force', 'origin', 'feature/r');
    const newHead = git(dev, 'rev-parse', 'HEAD');
    const newBase = git(dev, 'rev-parse', 'origin/develop');
    git(dev, 'switch', 'develop');
    expect(newHead).not.toBe(orig.head);
    // provider still reports the OLD commit list; only base/head were refreshed
    syncFake(1, 'feature/r', orig.shas, newHead, { baseSha: newBase });

    const plan = await planTransfer(ctx(), { prNumber: 1 });
    expect(plan.commits.map((c) => c.status)).toEqual(['not-in-head', 'not-in-head']);
    expect(plan.recommendedStrategy).toBe('patch');
    await expectCode(startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: orig.shas }), 'PRECONDITION');

    const out = await startTransfer(ctx(), { prNumber: 1, strategy: 'patch', commits: [] });
    expect(out.status).toBe('ready-for-review');
    expect(git(sc.orgClone, 'diff', '--name-only', 'origin/develop', 'HEAD').split('\n').sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('treats commit objects that are gone as missing', async () => {
    const { shas } = makePr(1, 'feature/a', [['a.txt', 'A\n', 'feat: add a']]);
    fake.prs.get(1)!.commits.unshift({ sha: 'f'.repeat(40), subject: 'ghost', author: 'x' });
    const plan = await planTransfer(ctx(), { prNumber: 1 });
    expect(plan.commits.find((c) => c.subject === 'ghost')?.status).toBe('missing');
    expect(plan.commits.find((c) => c.sha === shas[0])?.status).toBe('ready');
  });
});

describe('cherry-pick transfer', () => {
  it('transfers selected commits to a new branch, publishes it and creates one org PR', async () => {
    const { shas } = makePr(1, 'feature/a', [
      ['a.txt', 'A\n', 'feat: add a'],
      ['b.txt', 'B\n', 'feat: add b'],
    ]);
    const orgTip = sc.advance('org', 'org-only.txt', 'x\n', 'org moves on');

    // client sends the order reversed; the service must still apply in PR order
    const out = await startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: [shas[1], shas[0]] });
    expect(out.status).toBe('ready-for-review');
    expect(git(sc.orgClone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sync/intern-pr-1');
    expect(git(sc.orgClone, 'log', '--reverse', '--format=%s', 'origin/develop..HEAD').split('\n')).toEqual(['feat: add a', 'feat: add b']);
    expect(git(sc.orgClone, 'log', '-1', '--format=%B')).toContain('(cherry picked from commit');
    expect(git(sc.orgClone, 'rev-parse', 'HEAD~2')).toBe(orgTip); // branched from the latest org develop

    const review = await reviewTransfer(ctx(), { prNumber: 1 });
    expect(review.commits.map((c) => c.subject)).toEqual(['feat: add a', 'feat: add b']);
    expect(review.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(review.diff.text).toContain('+B');

    const tip = out.record.tip!;
    const pub = await publishTransfer(ctx(), { prNumber: 1, expectTip: tip, confirmPush: true });
    expect(pub.pushed).toBe(true);
    expect(pub.prCreated).toBe(true);
    expect(git(sc.orgBare, 'rev-parse', 'sync/intern-pr-1')).toBe(tip);
    expect(orgDevelopSha()).toBe(orgTip); // develop is never pushed to
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({ head: 'sync/intern-pr-1', base: 'develop' });
    expect(fake.created[0].body).toContain('https://example.test/intern/repo/pull/1');
    expect(fake.created[0].body).toContain('feat: add a');
    expect(getTransfer(transferKey(sc.internBare, 1))?.status).toBe('pr-created');

    // duplicate protection: no second PR, no second branch, no repeated cherry-pick
    await expectCode(publishTransfer(ctx(), { prNumber: 1, expectTip: tip, confirmPush: true }), 'DUPLICATE_TRANSFER');
    await expectCode(startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas }), 'DUPLICATE_TRANSFER');
    expect(fake.created).toHaveLength(1);
  });

  it('flags commits already transferred by another recorded transfer', async () => {
    const { shas } = makePr(1, 'feature/a', [['a.txt', 'A\n', 'feat: add a']]);
    const out = await startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas });
    await publishTransfer(ctx(), { prNumber: 1, expectTip: out.record.tip!, confirmPush: true });
    // a second PR stacked on the first, so its commit list also contains the first PR's commit
    const second = makePr(2, 'feature/a2', [['b.txt', 'B\n', 'feat: add b']], { from: 'feature/a' });
    fake.prs.get(2)!.commits.unshift(fake.prs.get(1)!.commits[0]);
    const plan = await planTransfer(ctx(), { prNumber: 2 });
    expect(plan.commits.map((c) => [c.sha, c.status])).toEqual([
      [shas[0], 'already-transferred'],
      [second.shas[0], 'ready'],
    ]);
  });

  it('records an explicitly skipped-empty commit when the change already exists in org', async () => {
    const { shas } = makePr(1, 'feature/a', [
      ['x.txt', 'X\n', 'feat: add x'],
      ['z.txt', 'Z\n', 'feat: add z'],
    ]);
    // org already has x.txt via a bigger commit, so the patch-id differs and plan cannot tell
    write(sc.orgDev, 'x.txt', 'X\n');
    commitFile(sc.orgDev, 'y.txt', 'Y\n', 'org adds x and y');
    git(sc.orgDev, 'push', 'origin', 'develop');

    const out = await startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas });
    expect(out.status).toBe('ready-for-review');
    expect(out.record.commits.map((c) => c.result)).toEqual(['skipped-empty', 'applied']);
  });

  it('refuses when nothing would be transferred and restores the original branch', async () => {
    const { shas } = makePr(1, 'feature/a', [['x.txt', 'X\n', 'feat: add x']]);
    // org has x.txt inside a bigger commit: patch-ids differ, so the plan cannot tell, but the pick is empty
    write(sc.orgDev, 'x.txt', 'X\n');
    commitFile(sc.orgDev, 'y.txt', 'Y\n', 'org adds x and y');
    git(sc.orgDev, 'push', 'origin', 'develop');
    await expectCode(startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas }), 'PRECONDITION');
    expect(git(sc.orgClone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
    expect(git(sc.orgClone, 'branch', '--list', 'sync/*')).toBe('');
    expect(getTransfer(transferKey(sc.internBare, 1))?.status).toBe('aborted');
  });

  it('stops on a cherry-pick conflict with recovery guidance, then aborts cleanly', async () => {
    const { shas } = makePr(1, 'feature/c', [['src/app.txt', 'line1\nPR\nline3\n', 'feat: change line2']]);
    sc.advance('org', 'src/app.txt', 'line1\nORG\nline3\n', 'org changes line2');
    const before = orgDevelopSha();

    const out = await startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas });
    expect(out.status).toBe('conflict');
    expect(out.conflictFiles).toEqual(['src/app.txt']);
    expect(out.recovery?.join(' ')).toMatch(/Abort/);
    expect(fs.existsSync(path.join(sc.orgClone, '.git', 'CHERRY_PICK_HEAD'))).toBe(true);
    expect(fs.readFileSync(path.join(sc.orgClone, 'src/app.txt'), 'utf8')).toContain('<<<<<<<'); // nothing silently resolved

    await expectCode(startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas }), 'OPERATION_IN_PROGRESS');
    const err = await expectCode(resumeTransfer(ctx(), { prNumber: 1, action: 'continue' }), 'CONFLICT');
    expect(err.details?.files).toEqual(['src/app.txt']);

    const aborted = await resumeTransfer(ctx(), { prNumber: 1, action: 'abort' });
    expect(aborted.status).toBe('aborted');
    expect(git(sc.orgClone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
    expect(git(sc.orgClone, 'branch', '--list', 'sync/*')).toBe('');
    expect(git(sc.orgClone, 'status', '--porcelain')).toBe('');
    expect(orgDevelopSha()).toBe(before);

    // an aborted transfer can be started again
    const again = await startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas });
    expect(again.status).toBe('conflict');
  });

  it('continues after the user resolves a conflict and applies the remaining commits', async () => {
    const { shas } = makePr(1, 'feature/c', [
      ['src/app.txt', 'line1\nPR\nline3\n', 'feat: change line2'],
      ['extra.txt', 'E\n', 'feat: extra'],
    ]);
    sc.advance('org', 'src/app.txt', 'line1\nORG\nline3\n', 'org changes line2');
    const out = await startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas });
    expect(out.status).toBe('conflict');

    write(sc.orgClone, 'src/app.txt', 'line1\nORG+PR\nline3\n');
    git(sc.orgClone, 'add', 'src/app.txt');
    const done = await resumeTransfer(ctx(), { prNumber: 1, action: 'continue' });
    expect(done.status).toBe('ready-for-review');
    expect(done.record.commits.map((c) => c.result)).toEqual(['applied', 'applied']);
    expect(git(sc.orgClone, 'log', '--reverse', '--format=%s', 'origin/develop..HEAD').split('\n')).toEqual(['feat: change line2', 'feat: extra']);
  });

  it('stops on a patch-strategy conflict and aborts cleanly', async () => {
    makePr(1, 'feature/c', [['src/app.txt', 'line1\nPR\nline3\n', 'feat: change line2']]);
    sc.advance('org', 'src/app.txt', 'line1\nORG\nline3\n', 'org changes line2');
    const out = await startTransfer(ctx(), { prNumber: 1, strategy: 'patch', commits: [] });
    expect(out.status).toBe('conflict');
    expect(out.conflictFiles).toEqual(['src/app.txt']);
    const aborted = await resumeTransfer(ctx(), { prNumber: 1, action: 'abort' });
    expect(aborted.status).toBe('aborted');
    expect(git(sc.orgClone, 'status', '--porcelain')).toBe('');
    expect(git(sc.orgClone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
  });

  it('refuses to start with uncommitted changes and leaves them untouched', async () => {
    const { shas } = makePr(1, 'feature/a', [['a.txt', 'A\n', 'feat: add a']]);
    write(sc.orgClone, 'README.md', 'my local edits\n');
    await expectCode(startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas }), 'DIRTY_WORKTREE');
    expect(fs.readFileSync(path.join(sc.orgClone, 'README.md'), 'utf8')).toBe('my local edits\n');
    expect(git(sc.orgClone, 'branch', '--list', 'sync/*')).toBe('');
    expect(getTransfer(transferKey(sc.internBare, 1))).toBeUndefined();
  });

  it('requires a selection and rejects commits that are not in the PR', async () => {
    makePr(1, 'feature/a', [['a.txt', 'A\n', 'feat: add a']]);
    await expectCode(startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: [] }), 'VALIDATION');
    await expectCode(startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: ['e'.repeat(40)] }), 'VALIDATION');
  });
});

describe('publish safety', () => {
  async function ready() {
    const { shas } = makePr(1, 'feature/a', [['a.txt', 'A\n', 'feat: add a']]);
    const out = await startTransfer(ctx(), { prNumber: 1, strategy: 'cherry-pick', commits: shas });
    return out.record.tip!;
  }

  it('blocks every write in preview-only mode', async () => {
    makePr(1, 'feature/a', [['a.txt', 'A\n', 'feat: add a']]);
    await expectCode(startTransfer(ctx(true), { prNumber: 1, strategy: 'patch', commits: [] }), 'PREVIEW_ONLY');
    await expectCode(publishTransfer(ctx(true), { prNumber: 1, expectTip: 'a'.repeat(40), confirmPush: true }), 'PREVIEW_ONLY');
    await expectCode(resumeTransfer(ctx(true), { prNumber: 1, action: 'abort' }), 'PREVIEW_ONLY');
  });

  it('refuses to publish if the branch changed after review', async () => {
    const tip = await ready();
    commitFile(sc.orgClone, 'sneaky.txt', 's\n', 'extra commit after review');
    await expectCode(publishTransfer(ctx(), { prNumber: 1, expectTip: tip, confirmPush: true }), 'STALE');
    expect(() => git(sc.orgBare, 'rev-parse', 'sync/intern-pr-1')).toThrow();
  });

  it('keeps the transfer retryable when the server rejects the push', async () => {
    const tip = await ready();
    const hook = path.join(sc.orgBare, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "remote rejected: branch policy" >&2\nexit 1\n', { mode: 0o755 });
    await expectCode(publishTransfer(ctx(), { prNumber: 1, expectTip: tip, confirmPush: true }), 'REMOTE_REJECTED');
    expect(getTransfer(transferKey(sc.internBare, 1))?.status).toBe('ready-for-review');
    fs.rmSync(hook);
    const pub = await publishTransfer(ctx(), { prNumber: 1, expectTip: tip, confirmPush: true });
    expect(pub.prCreated).toBe(true);
  });

  it('survives a PR-creation failure after a successful push without duplicating anything', async () => {
    const tip = await ready();
    fake.failCreate = new AppError('PROVIDER', 'GitHub API error 500.');
    const err = await expectCode(publishTransfer(ctx(), { prNumber: 1, expectTip: tip, confirmPush: true }), 'PROVIDER');
    expect(err.details?.pushed).toBe(true);
    expect(getTransfer(transferKey(sc.internBare, 1))?.status).toBe('pushed');
    expect(git(sc.orgBare, 'rev-parse', 'sync/intern-pr-1')).toBe(tip);

    fake.failCreate = null;
    const pub = await publishTransfer(ctx(), { prNumber: 1, expectTip: tip, confirmPush: true });
    expect(pub.prCreated).toBe(true);
    expect(fake.created).toHaveLength(1);
  });

  it('reuses an already-open org PR instead of creating another', async () => {
    const tip = await ready();
    fake.existingOpen = { number: 7, url: 'https://example.test/org/repo/pull/7' };
    const pub = await publishTransfer(ctx(), { prNumber: 1, expectTip: tip, confirmPush: true });
    expect(pub.prCreated).toBe(false);
    expect(pub.orgPrUrl).toBe('https://example.test/org/repo/pull/7');
    expect(fake.created).toHaveLength(0);
  });

  it('pushes the branch but reports honestly when the org host has no PR API', async () => {
    const tip = await ready();
    const noApi: TransferContext = { ...ctx(), orgProvider: null };
    const pub = await publishTransfer(noApi, { prNumber: 1, expectTip: tip, confirmPush: true });
    expect(pub.pushed).toBe(true);
    expect(pub.prCreated).toBe(false);
    expect(pub.note).toMatch(/manually/i);
  });

  it('refuses to overwrite an existing remote branch with different commits', async () => {
    const tip = await ready();
    git(sc.orgDev, 'fetch', 'origin');
    git(sc.orgDev, 'switch', '-c', 'sync/intern-pr-1', 'origin/develop');
    commitFile(sc.orgDev, 'other.txt', 'o\n', 'someone else');
    git(sc.orgDev, 'push', 'origin', 'sync/intern-pr-1');
    await expectCode(publishTransfer(ctx(), { prNumber: 1, expectTip: tip, confirmPush: true }), 'STALE');
  });
});
