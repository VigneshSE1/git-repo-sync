import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors';
import { validateRepo, type CommitSummary, type FileChange, type GitRepo } from '../git/repo';
import { withRepoLocks } from '../locks';
import { logEvent } from '../log';
import type { GitProvider, ProviderFile, PullRequestSummary } from '../providers/types';
import { normalizeRemote } from '../remote';
import {
  getTransfer,
  listTransfers,
  putTransfer,
  transferKey,
  updateTransfer,
  type TransferCommitRecord,
  type TransferRecord,
} from '../state';
import { assertWritable, short, stamp, type RepoTarget } from './common';

export interface TransferContext {
  org: RepoTarget;
  intern: RepoTarget;
  /** Provider used to read the intern repo's PRs. */
  internProvider: GitProvider;
  /** Provider used to create the org PR; null when the org host has no PR API integration. */
  orgProvider: GitProvider | null;
  previewOnly: boolean;
}

export type PlanCommitStatus =
  | 'ready'
  | 'merge'
  | 'already-in-org'
  | 'equivalent-in-org'
  | 'already-transferred'
  | 'not-in-head'
  | 'missing';

export interface PlanCommit {
  sha: string;
  subject: string;
  author: string;
  parentCount: number;
  status: PlanCommitStatus;
  selectable: boolean;
  files: FileChange[];
  note?: string;
}

export interface TransferPlan {
  pr: PullRequestSummary;
  fetchedHeadSha: string;
  headChanged: boolean;
  orgSha: string;
  branchName: string;
  commits: PlanCommit[];
  files: Array<ProviderFile | FileChange>;
  recommendedStrategy: 'cherry-pick' | 'patch';
  strategyReasons: string[];
  existing: TransferRecord | null;
  warnings: string[];
}

const internHeadRef = (n: number) => `refs/sync/intern/pr-${n}`;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbbcd8e2';
const orgRepoRef = (ctx: TransferContext) => ({ url: ctx.org.url });
const internRepoRef = (ctx: TransferContext) => ({ url: ctx.intern.url });

export function defaultBranchName(prNumber: number): string {
  return `sync/intern-pr-${prNumber}`;
}

async function openOrg(ctx: TransferContext) {
  return validateRepo(ctx.org, 'org', {});
}

/** Annotates the PR list with any recorded transfer state. */
export async function listPullRequestsWithStatus(ctx: TransferContext, filter: 'open' | 'merged' | 'all') {
  const prs = await ctx.internProvider.listPullRequests(internRepoRef(ctx), filter);
  return prs.map((pr) => ({ ...pr, transfer: getTransfer(transferKey(ctx.intern.url, pr.number))?.status ?? null }));
}

async function buildPlan(ctx: TransferContext, prNumber: number, org: { repo: GitRepo; remote: string }): Promise<TransferPlan> {
  const repo = org.repo;
  await repo.fetchRemote(org.remote);
  const pr = await ctx.internProvider.getPullRequest(internRepoRef(ctx), prNumber);
  const headRefLocal = internHeadRef(prNumber);
  await repo.fetchFromUrl(ctx.intern.url, ctx.internProvider.pullRequestHeadRef(pr), headRefLocal);
  const fetchedHead = await repo.resolve(headRefLocal);
  const orgRef = `refs/remotes/${org.remote}/${ctx.org.branch}`;
  const orgSha = await repo.resolve(orgRef);
  if (!fetchedHead) throw new AppError('NOT_FOUND', `Could not fetch the head of PR #${prNumber}.`);
  if (!orgSha) throw new AppError('REPO_INVALID', `Org remote has no branch ${ctx.org.branch}.`);

  const warnings: string[] = [];
  const headChanged = !!pr.headSha && pr.headSha !== fetchedHead;
  if (headChanged) warnings.push(`PR head moved: provider reported ${short(pr.headSha)} but the fetched head is ${short(fetchedHead)}. Using the fetched head.`);
  if (pr.state === 'merged') warnings.push('This PR is already merged on the intern side. Transferring still works; verify the org does not have these changes yet.');
  if (pr.state === 'closed') warnings.push('This PR was closed without merging.');

  const provCommits = await ctx.internProvider.listPullRequestCommits(internRepoRef(ctx), prNumber);
  const wanted = new Set(provCommits.map((c) => c.sha));
  const order = (await repo.run(['rev-list', '--reverse', '--topo-order', '--max-count=5000', fetchedHead])).out
    .split(/\r?\n/)
    .filter((s) => wanted.has(s));
  const rank = new Map(order.map((s, i) => [s, i]));
  const sorted = [...provCommits].sort((a, b) => (rank.get(a.sha) ?? -1) - (rank.get(b.sha) ?? -1));

  const equivalents = await repo.patchEquivalent(orgRef, fetchedHead);
  const priorTransferred = new Set<string>();
  for (const t of listTransfers()) {
    if (normalizeRemote(t.internUrl) !== normalizeRemote(ctx.intern.url)) continue;
    if (t.prNumber === prNumber || !['pushed', 'pr-created'].includes(t.status)) continue;
    for (const c of t.commits) if (c.result === 'applied') priorTransferred.add(c.sha);
  }

  const commits: PlanCommit[] = [];
  for (const pc of sorted) {
    const base = { sha: pc.sha, subject: pc.subject, author: pc.author };
    const resolved = await repo.resolve(pc.sha);
    if (!resolved) {
      commits.push({ ...base, parentCount: 0, status: 'missing', selectable: false, files: [], note: 'Commit object is not available (the PR branch was probably force-pushed or rebased).' });
      continue;
    }
    const parents = await repo.parents(pc.sha);
    const files = await repo.commitFiles(pc.sha);
    const common = { ...base, parentCount: parents.length, files };
    if (!(await repo.isAncestor(pc.sha, fetchedHead))) {
      commits.push({ ...common, status: 'not-in-head', selectable: false, note: 'Not reachable from the current PR head: the branch was rebased/rewritten after this commit was listed.' });
    } else if (parents.length > 1) {
      commits.push({ ...common, status: 'merge', selectable: false, note: 'Merge commit: cannot be cherry-picked safely. Use the reviewed patch-based transfer.' });
    } else if (await repo.isAncestor(pc.sha, orgSha)) {
      commits.push({ ...common, status: 'already-in-org', selectable: false, note: `Already contained in org ${ctx.org.branch}.` });
    } else if (equivalents.has(pc.sha)) {
      commits.push({ ...common, status: 'equivalent-in-org', selectable: false, note: `An identical patch already exists in org ${ctx.org.branch} (different SHA).` });
    } else if (priorTransferred.has(pc.sha)) {
      commits.push({ ...common, status: 'already-transferred', selectable: false, note: 'Already transferred by another recorded transfer.' });
    } else {
      commits.push({ ...common, status: 'ready', selectable: true });
    }
  }

  const reasons: string[] = [];
  if (commits.some((c) => c.status === 'merge')) reasons.push('PR contains merge commits.');
  if (commits.some((c) => c.status === 'not-in-head' || c.status === 'missing')) reasons.push('Commit SHAs changed (rebase / force-push): listed commits no longer match the PR head.');
  if (commits.length === 0) reasons.push('The provider returned no commits (e.g. squash-merged PR).');
  const recommendedStrategy = reasons.length ? 'patch' : 'cherry-pick';
  if (commits.length && commits.every((c) => !c.selectable) && recommendedStrategy === 'cherry-pick') {
    warnings.push('Every commit is already present in org; there may be nothing to transfer.');
  }

  let files: Array<ProviderFile | FileChange> = [];
  try {
    files = await ctx.internProvider.listPullRequestFiles(internRepoRef(ctx), prNumber);
  } catch (e) {
    warnings.push(`Could not load the file list from the provider (${e instanceof AppError ? e.message : 'error'}).`);
  }

  return {
    pr,
    fetchedHeadSha: fetchedHead,
    headChanged,
    orgSha,
    branchName: defaultBranchName(prNumber),
    commits,
    files,
    recommendedStrategy,
    strategyReasons: reasons,
    existing: getTransfer(transferKey(ctx.intern.url, prNumber)) ?? null,
    warnings,
  };
}

export async function planTransfer(ctx: TransferContext, req: { prNumber: number }): Promise<TransferPlan> {
  return withRepoLocks([ctx.org.path], 'transfer plan', async () => {
    const org = await openOrg(ctx);
    return buildPlan(ctx, req.prNumber, org);
  });
}

function saveCommit(rec: TransferRecord, idx: number, patch: Partial<TransferCommitRecord>): TransferRecord {
  const commits = rec.commits.map((c, i) => (i === idx ? { ...c, ...patch } : c));
  return updateTransfer(rec.key, { commits });
}

export interface TransferOutcome {
  status: TransferRecord['status'];
  record: TransferRecord;
  conflictFiles?: string[];
  recovery?: string[];
}

function conflictRecovery(ctx: TransferContext, rec: TransferRecord, files: string[]): string[] {
  const strategy = rec.strategy === 'cherry-pick' ? 'cherry-pick' : 'patch apply';
  return [
    `The ${strategy} stopped on conflicts in ${files.length} file(s): ${files.join(', ')}.`,
    `Nothing was skipped or discarded. The repository is on branch ${rec.branch} in ${ctx.org.path}.`,
    'Option 1: resolve the conflict markers in those files, `git add` them, then press "Continue" here.',
    `Option 2: press "Abort" here to restore ${rec.originalBranch} and delete ${rec.branch}.`,
    'Option 3: if commits conflict heavily, abort and use the patch-based strategy on a fresh plan.',
  ];
}

async function runCherryPicks(ctx: TransferContext, repo: GitRepo, key: string): Promise<TransferOutcome> {
  let rec = getTransfer(key)!;
  for (let i = 0; i < rec.commits.length; i++) {
    const c = rec.commits[i];
    if (c.result !== 'pending') continue;
    const res = await repo.cherryPick(c.sha);
    if (res.ok) {
      rec = saveCommit(rec, i, { result: 'applied', newSha: (await repo.resolve('HEAD')) ?? undefined });
      continue;
    }
    const op = await repo.inProgressOperation();
    if (op === 'cherry-pick') {
      const unmerged = await repo.unmergedFiles();
      if (unmerged.length === 0) {
        // The change already exists on the branch: git stops with an empty cherry-pick. Record it explicitly.
        await repo.cherryPickSkip();
        rec = saveCommit(rec, i, { result: 'skipped-empty' });
        logEvent({ scope: 'org', kind: 'info', message: `Commit ${short(c.sha)} was already applied (empty after cherry-pick); recorded as skipped-empty` });
        continue;
      }
      rec = saveCommit(rec, i, { result: 'conflict' });
      rec = updateTransfer(key, { status: 'conflict', conflictFiles: unmerged });
      return { status: 'conflict', record: rec, conflictFiles: unmerged, recovery: conflictRecovery(ctx, rec, unmerged) };
    }
    updateTransfer(key, { status: 'conflict', error: res.err.split(/\r?\n/)[0] });
    throw new AppError('GIT', `Cherry-pick of ${short(c.sha)} failed: ${res.err.split(/\r?\n/)[0]}`, {
      hint: 'Use Abort to restore your original branch.',
    });
  }
  return finishTransfer(ctx, repo, key);
}

async function finishTransfer(ctx: TransferContext, repo: GitRepo, key: string): Promise<TransferOutcome> {
  const rec = getTransfer(key)!;
  const applied = rec.commits.filter((c) => c.result === 'applied').length;
  if (applied === 0) {
    await restoreOriginal(repo, rec);
    const aborted = updateTransfer(key, { status: 'aborted', error: 'Nothing to transfer: every selected commit was already present in org.' });
    throw new AppError('PRECONDITION', aborted.error!, { hint: 'No branch was created. Nothing to push.' });
  }
  const tip = (await repo.resolve('HEAD'))!;
  const done = updateTransfer(key, { status: 'ready-for-review', tip, conflictFiles: undefined, error: undefined });
  void ctx;
  return { status: 'ready-for-review', record: done };
}

async function restoreOriginal(repo: GitRepo, rec: TransferRecord): Promise<void> {
  if ((await repo.currentBranch()) === rec.branch) {
    if (await repo.branchExists(rec.originalBranch)) await repo.switchBranch(rec.originalBranch);
    else await repo.switchBranch(rec.targetBranch);
  }
  if (await repo.branchExists(rec.branch)) await repo.deleteBranch(rec.branch);
}

export interface StartRequest {
  prNumber: number;
  strategy: 'cherry-pick' | 'patch';
  commits: string[];
  allowRepeat?: boolean;
}

export async function startTransfer(ctx: TransferContext, req: StartRequest): Promise<TransferOutcome> {
  assertWritable(ctx.previewOnly);
  return withRepoLocks([ctx.org.path], 'transfer start', async () => {
    const org = await openOrg(ctx);
    const repo = org.repo;
    await repo.assertCleanAndIdle();

    const key = transferKey(ctx.intern.url, req.prNumber);
    const existing = getTransfer(key);
    if (existing && existing.status !== 'aborted') {
      const finished = existing.status === 'pushed' || existing.status === 'pr-created';
      if (!(finished && req.allowRepeat)) {
        throw new AppError('DUPLICATE_TRANSFER', `PR #${req.prNumber} already has a transfer in state "${existing.status}" (branch ${existing.branch}).`, {
          hint: finished
            ? existing.orgPrUrl
              ? `An org PR already exists: ${existing.orgPrUrl}. Enable "allow repeat" only if you really need a second transfer.`
              : 'The branch was already pushed. Re-run Publish to create the PR, or enable "allow repeat".'
            : 'Resume or abort the existing transfer first.',
          details: { status: existing.status, branch: existing.branch, orgPrUrl: existing.orgPrUrl },
        });
      }
    }

    const plan = await buildPlan(ctx, req.prNumber, org);
    const byRepeat = existing && existing.status !== 'aborted' ? `-${stamp()}` : '';
    const branch = `${plan.branchName}${byRepeat}`;
    if (branch === ctx.org.branch || !/^sync\//.test(branch)) {
      throw new AppError('PRECONDITION', 'Refusing to use that branch name for a transfer.');
    }
    if (await repo.branchExists(branch)) {
      throw new AppError('PRECONDITION', `Local branch ${branch} already exists.`, {
        hint: `Inspect it, then delete it with \`git branch -D ${branch}\` if it is a leftover.`,
      });
    }
    if (await repo.lsRemoteHead(org.remote, branch)) {
      throw new AppError('DUPLICATE_TRANSFER', `Branch ${branch} already exists on the org remote.`, {
        hint: 'A previous transfer probably pushed it. Open its PR, or enable "allow repeat" to use a new branch name.',
      });
    }

    let commits: TransferCommitRecord[];
    let patchMessage: string | undefined;
    let patchBase: string | undefined;
    if (req.strategy === 'cherry-pick') {
      if (req.commits.length === 0) throw new AppError('VALIDATION', 'Select at least one commit to transfer.');
      const set = new Set(req.commits.map((s) => s.toLowerCase()));
      if (set.size !== req.commits.length) throw new AppError('VALIDATION', 'Duplicate commits in selection.');
      const chosen = plan.commits.filter((c) => set.has(c.sha.toLowerCase()));
      if (chosen.length !== set.size) {
        throw new AppError('VALIDATION', 'Selection contains commits that are not part of this PR.', {
          hint: 'Reload the plan: the PR may have changed.',
        });
      }
      const blocked = chosen.filter((c) => !c.selectable);
      if (blocked.length) {
        throw new AppError('PRECONDITION', `${blocked.length} selected commit(s) cannot be cherry-picked: ${blocked.map((b) => `${short(b.sha)} (${b.status})`).join(', ')}.`, {
          hint: plan.recommendedStrategy === 'patch' ? 'Use the patch-based strategy for this PR.' : 'Deselect those commits.',
          details: { blocked: blocked.map((b) => ({ sha: b.sha, status: b.status })) },
        });
      }
      // Always apply in PR order, regardless of the order the client sent.
      commits = chosen.map((c) => ({ sha: c.sha, subject: c.subject, result: 'pending' as const }));
    } else {
      commits = plan.commits.map((c) => ({ sha: c.sha, subject: c.subject, result: 'pending' as const }));
      const head = plan.fetchedHeadSha;
      const pb = plan.pr.baseSha;
      if (pb && (await repo.resolve(pb)) && (await repo.isAncestor(pb, head))) patchBase = pb;
      else patchBase = (await repo.mergeBase(head, plan.orgSha)) ?? EMPTY_TREE;
      const authors = (await repo.run(['log', '--format=%an <%ae>', `${patchBase === EMPTY_TREE ? '' : `${patchBase}..`}${head}`])).out
        .split(/\r?\n/)
        .filter(Boolean);
      const unique = [...new Set(authors)];
      patchMessage = [
        `Transfer intern PR #${plan.pr.number}: ${plan.pr.title}`,
        '',
        `Original PR: ${plan.pr.url}`,
        `Source head: ${plan.fetchedHeadSha}`,
        `Patch base: ${patchBase === EMPTY_TREE ? '(empty tree)' : patchBase}`,
        '',
        ...unique.map((a) => `Co-authored-by: ${a}`),
      ].join('\n');
    }

    const originalBranch = await repo.currentBranch();
    putTransfer({
      key,
      prNumber: plan.pr.number,
      prUrl: plan.pr.url,
      prTitle: plan.pr.title,
      internUrl: ctx.intern.url,
      orgUrl: ctx.org.url,
      targetBranch: ctx.org.branch,
      branch,
      strategy: req.strategy,
      status: 'in-progress',
      originalBranch,
      baseSha: plan.orgSha,
      commits,
      patchMessage,
      createdAt: new Date().toISOString(),
      updatedAt: '',
    });

    await repo.createBranch(branch, `refs/remotes/${org.remote}/${ctx.org.branch}`, true);
    logEvent({ scope: 'org', kind: 'info', message: `Created transfer branch ${branch} from ${ctx.org.branch}@${short(plan.orgSha)}` });

    if (req.strategy === 'cherry-pick') return runCherryPicks(ctx, repo, key);
    return applyPatchStrategy(ctx, repo, key, plan.fetchedHeadSha, patchBase!);
  });
}

async function applyPatchStrategy(ctx: TransferContext, repo: GitRepo, key: string, head: string, base: string): Promise<TransferOutcome> {
  const rec = getTransfer(key)!;
  const patch = (await repo.run(['diff', '--binary', '--full-index', base, head])).out;
  if (!patch.trim()) {
    await restoreOriginal(repo, rec);
    updateTransfer(key, { status: 'aborted', error: 'The PR produces an empty patch against its base.' });
    throw new AppError('PRECONDITION', 'The PR produces an empty patch; there is nothing to transfer.');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grs-patch-'));
  const file = path.join(dir, 'pr.patch');
  fs.writeFileSync(file, patch);
  try {
    const res = await repo.applyPatch(file);
    if (!res.ok) {
      const unmerged = await repo.unmergedFiles();
      if (unmerged.length === 0) {
        await repo.run(['reset', '--hard', 'HEAD']);
        await restoreOriginal(repo, rec);
        updateTransfer(key, { status: 'aborted', error: res.err.split(/\r?\n/)[0] });
        throw new AppError('GIT', `The patch could not be applied: ${res.err.split(/\r?\n/)[0]}`, {
          hint: 'No changes were kept and your original branch was restored.',
        });
      }
      const updated = updateTransfer(key, { status: 'conflict', conflictFiles: unmerged });
      return { status: 'conflict', record: updated, conflictFiles: unmerged, recovery: conflictRecovery(ctx, updated, unmerged) };
    }
    return commitPatch(ctx, repo, key);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function commitPatch(ctx: TransferContext, repo: GitRepo, key: string): Promise<TransferOutcome> {
  const rec = getTransfer(key)!;
  const res = await repo.commit(rec.patchMessage ?? `Transfer intern PR #${rec.prNumber}`);
  if (!res.ok) {
    updateTransfer(key, { status: 'conflict', error: res.err.split(/\r?\n/)[0] });
    throw new AppError('GIT', `Commit failed: ${res.err.split(/\r?\n/)[0] || res.out.split(/\r?\n/)[0]}`, {
      hint: 'Check that git user.name / user.email are configured, then Continue again, or Abort.',
    });
  }
  const sha = (await repo.resolve('HEAD'))!;
  const commits = rec.commits.map((c) => ({ ...c, result: 'applied' as const, newSha: sha }));
  updateTransfer(key, { commits });
  return finishTransfer(ctx, repo, key);
}

export async function resumeTransfer(ctx: TransferContext, req: { prNumber: number; action: 'continue' | 'abort' }): Promise<TransferOutcome> {
  assertWritable(ctx.previewOnly);
  return withRepoLocks([ctx.org.path], `transfer ${req.action}`, async () => {
    const org = await openOrg(ctx);
    const repo = org.repo;
    const key = transferKey(ctx.intern.url, req.prNumber);
    const rec = getTransfer(key);
    if (!rec) throw new AppError('NOT_FOUND', `No transfer recorded for PR #${req.prNumber}.`);
    const resumable = ['conflict', 'in-progress', 'ready-for-review'];
    if (!resumable.includes(rec.status)) {
      throw new AppError('PRECONDITION', `Transfer is "${rec.status}"; nothing to ${req.action}.`, {
        hint: rec.status === 'pushed' || rec.status === 'pr-created' ? 'The branch is already on the remote; manage it there.' : undefined,
      });
    }
    if ((await repo.currentBranch()) !== rec.branch) {
      throw new AppError('PRECONDITION', `Org clone is not on ${rec.branch} (it is on ${await repo.currentBranch()}).`, {
        hint: `Run \`git switch ${rec.branch}\` in ${ctx.org.path} (or delete the stale record state), then retry.`,
      });
    }

    if (req.action === 'abort') {
      const op = await repo.inProgressOperation();
      if (op === 'cherry-pick') await repo.cherryPickAbort();
      else if (op === 'merge') await repo.mergeAbort();
      else await repo.run(['reset', '--hard', rec.baseSha]);
      await restoreOriginal(repo, rec);
      const aborted = updateTransfer(key, { status: 'aborted', conflictFiles: undefined, error: undefined });
      return { status: 'aborted', record: aborted };
    }

    // continue
    if (rec.status !== 'conflict') {
      throw new AppError('PRECONDITION', 'Only a transfer stopped on a conflict can be continued.');
    }
    const unmerged = await repo.unmergedFiles();
    if (unmerged.length) {
      throw new AppError('CONFLICT', `Conflicts remain in ${unmerged.length} file(s): ${unmerged.join(', ')}.`, {
        hint: 'Resolve them, `git add` the files, then Continue again.',
        details: { files: unmerged },
      });
    }
    if (await repo.hasConflictMarkers()) {
      throw new AppError('CONFLICT', 'Staged files still contain conflict markers.', { hint: 'Remove the <<<<<<< / ======= / >>>>>>> markers, `git add`, then Continue.' });
    }
    if (rec.strategy === 'patch') return commitPatch(ctx, repo, key);

    const idx = rec.commits.findIndex((c) => c.result === 'conflict');
    const res = await repo.cherryPickContinue();
    if (!res.ok) {
      if ((await repo.inProgressOperation()) === 'cherry-pick' && (await repo.unmergedFiles()).length === 0) {
        await repo.cherryPickSkip();
        if (idx >= 0) saveCommit(rec, idx, { result: 'skipped-empty' });
      } else {
        throw new AppError('GIT', `Could not continue: ${res.err.split(/\r?\n/)[0]}`, { hint: 'Make sure all resolved files are staged, then retry or Abort.' });
      }
    } else if (idx >= 0) {
      saveCommit(rec, idx, { result: 'applied', newSha: (await repo.resolve('HEAD')) ?? undefined });
    }
    updateTransfer(key, { status: 'in-progress', conflictFiles: undefined });
    return runCherryPicks(ctx, repo, key);
  });
}

export interface TransferReview {
  record: TransferRecord;
  commits: CommitSummary[];
  files: FileChange[];
  stat: string;
  diff: { text: string; truncated: boolean };
}

export async function reviewTransfer(ctx: TransferContext, req: { prNumber: number }): Promise<TransferReview> {
  return withRepoLocks([ctx.org.path], 'transfer review', async () => {
    const org = await openOrg(ctx);
    const rec = getTransfer(transferKey(ctx.intern.url, req.prNumber));
    if (!rec) throw new AppError('NOT_FOUND', `No transfer recorded for PR #${req.prNumber}.`);
    const repo = org.repo;
    if (!(await repo.branchExists(rec.branch))) {
      throw new AppError('NOT_FOUND', `Local branch ${rec.branch} no longer exists.`);
    }
    const ref = `refs/heads/${rec.branch}`;
    const range = `${rec.baseSha}..${ref}`;
    return {
      record: rec,
      commits: (await repo.log(range)).reverse(),
      files: await repo.diffFiles(rec.baseSha, ref),
      stat: await repo.diffStat(rec.baseSha, ref),
      diff: await repo.diffText([rec.baseSha, ref]),
    };
  });
}

export function buildPrBody(rec: TransferRecord, stat: string, commits: CommitSummary[]): string {
  const lines = [
    `Transfer of reviewed intern PR: ${rec.prUrl}`,
    '',
    `**Original PR:** #${rec.prNumber} - ${rec.prTitle}`,
    `**Strategy:** ${rec.strategy === 'cherry-pick' ? 'commit-by-commit cherry-pick (-x)' : 'reviewed patch-based transfer (single commit)'}`,
    `**Base:** \`${rec.targetBranch}\` @ \`${short(rec.baseSha)}\``,
    '',
    '### Transferred commits',
    ...commits.map((c) => `- \`${short(c.sha)}\` ${c.subject} (${c.author})`),
  ];
  const skipped = rec.commits.filter((c) => c.result === 'skipped-empty');
  if (skipped.length) {
    lines.push('', '### Skipped (change already present)', ...skipped.map((c) => `- \`${short(c.sha)}\` ${c.subject}`));
  }
  lines.push('', '### Summary of changes', '```', stat || '(no diff stat)', '```', '', '_Created by Git Repo Sync. Please review and merge manually; this tool never merges._');
  return lines.join('\n');
}

export interface PublishResult {
  pushed: boolean;
  pushedSha: string;
  prCreated: boolean;
  orgPrUrl?: string;
  manualPrUrl?: string | null;
  note?: string;
}

export async function publishTransfer(
  ctx: TransferContext,
  req: { prNumber: number; expectTip: string; confirmPush: true; title?: string },
): Promise<PublishResult> {
  assertWritable(ctx.previewOnly);
  return withRepoLocks([ctx.org.path], 'transfer publish', async () => {
    const org = await openOrg(ctx);
    const repo = org.repo;
    const key = transferKey(ctx.intern.url, req.prNumber);
    const rec = getTransfer(key);
    if (!rec) throw new AppError('NOT_FOUND', `No transfer recorded for PR #${req.prNumber}.`);
    if (rec.status === 'pr-created') {
      throw new AppError('DUPLICATE_TRANSFER', 'An org PR was already created for this transfer.', { hint: rec.orgPrUrl, details: { orgPrUrl: rec.orgPrUrl } });
    }
    if (rec.status !== 'ready-for-review' && rec.status !== 'pushed') {
      throw new AppError('PRECONDITION', `Transfer is "${rec.status}"; it must be ready for review before publishing.`);
    }
    // Hard guard: PR transfer never writes to the target branch.
    if (rec.branch === ctx.org.branch || rec.branch === rec.targetBranch || !rec.branch.startsWith('sync/')) {
      throw new AppError('PRECONDITION', 'Refusing to push: not a dedicated transfer branch.');
    }
    const tip = await repo.resolve(`refs/heads/${rec.branch}`);
    if (!tip || tip !== req.expectTip || tip !== rec.tip) {
      throw new AppError('STALE', 'The transfer branch changed since you reviewed it.', { hint: 'Reload the review and confirm again.' });
    }
    if (await repo.inProgressOperation()) throw new AppError('OPERATION_IN_PROGRESS', 'An operation is in progress in the org clone.');

    // Fresh remote verification, then a plain (never forced) push of the new branch.
    await repo.fetchRemote(org.remote);
    const remoteTip = await repo.lsRemoteHead(org.remote, rec.branch);
    if (remoteTip && remoteTip !== tip) {
      throw new AppError('STALE', `Branch ${rec.branch} already exists on the org remote with different commits.`, {
        hint: 'Someone else may have pushed it. Pick a new transfer (allow repeat) instead of overwriting.',
      });
    }
    if (!remoteTip) {
      await repo.push(org.remote, `refs/heads/${rec.branch}`, rec.branch, { setUpstream: true });
      const verified = await repo.lsRemoteHead(org.remote, rec.branch);
      if (verified !== tip) throw new AppError('GIT', 'Push finished but the remote branch does not match.', { details: { verified } });
    }
    let current = updateTransfer(key, { status: 'pushed', error: undefined });

    const provider = ctx.orgProvider;
    const manual = provider?.manualCompareUrl(orgRepoRef(ctx), rec.branch, rec.targetBranch) ?? null;
    if (!provider || !provider.capabilities.createPullRequest) {
      current = updateTransfer(key, { manualPrUrl: manual });
      return {
        pushed: true,
        pushedSha: tip,
        prCreated: false,
        manualPrUrl: manual,
        note: 'The branch was pushed, but no PR API is available for the org repository. Open the PR manually.',
      };
    }
    try {
      const found = await provider.findOpenPullRequest(orgRepoRef(ctx), rec.branch, rec.targetBranch);
      if (found) {
        updateTransfer(key, { status: 'pr-created', orgPrUrl: found.url, orgPrNumber: found.number });
        return { pushed: true, pushedSha: tip, prCreated: false, orgPrUrl: found.url, note: 'An open org PR for this branch already existed; it was reused.' };
      }
      const commits = (await repo.log(`${rec.baseSha}..refs/heads/${rec.branch}`)).reverse();
      const stat = await repo.diffStat(rec.baseSha, `refs/heads/${rec.branch}`);
      const created = await provider.createPullRequest(orgRepoRef(ctx), {
        title: req.title || `Transfer intern PR #${rec.prNumber}: ${rec.prTitle}`,
        body: buildPrBody(current, stat, commits),
        head: rec.branch,
        base: rec.targetBranch,
      });
      updateTransfer(key, { status: 'pr-created', orgPrUrl: created.url, orgPrNumber: created.number });
      return { pushed: true, pushedSha: tip, prCreated: true, orgPrUrl: created.url };
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError('PROVIDER', 'Creating the org PR failed.', { cause: e });
      updateTransfer(key, { error: err.message, manualPrUrl: manual });
      throw new AppError(err.code, `Branch pushed, but the org PR was not created: ${err.message}`, {
        hint: `Fix the issue and run Publish again (the push is skipped when already done)${manual ? `, or open it manually: ${manual}` : ''}.`,
        details: { pushed: true, manualPrUrl: manual },
      });
    }
  });
}
