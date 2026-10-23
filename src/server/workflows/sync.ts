import { AppError } from '../errors';
import { GitRepo, validateRepo, type CommitSummary, type FileChange } from '../git/repo';
import { logEvent } from '../log';
import { withRepoLocks } from '../locks';
import { getSyncRecord, putSyncRecord, clearSyncRecord } from '../state';
import { assertWritable, short, stamp, type RepoTarget } from './common';

export interface SyncContext {
  org: RepoTarget;
  intern: RepoTarget;
  previewOnly: boolean;
}

export type SyncStrategy = 'merge' | 'exact';
export type Relation = 'identical' | 'behind' | 'ahead' | 'diverged' | 'unrelated';

export interface SyncPreview {
  strategy: SyncStrategy;
  branch: string;
  orgSha: string;
  internSha: string;
  orgLatest: CommitSummary | null;
  internLatest: CommitSummary | null;
  relation: Relation;
  /** Commits on org that intern lacks. */
  behind: CommitSummary[];
  /** Commits only on intern. */
  ahead: CommitSummary[];
  behindCount: number;
  aheadCount: number;
  files: FileChange[];
  conflicts: string[];
  unrelatedHistories: boolean;
  needsForcePush: boolean;
  /** Intern-only commits that exact sync would drop from the branch. */
  discardedCommits: CommitSummary[];
  diff: { text: string; truncated: boolean };
  upToDate: boolean;
  worktree: { clean: boolean; currentBranch: string; untracked: number };
  warnings: string[];
}

export interface SyncApplyResult {
  changed: boolean;
  strategy: SyncStrategy;
  branch: string;
  backupBranch: string | null;
  previousLocalSha: string | null;
  appliedSha: string;
  needsForcePush: boolean;
  verification: Array<{ check: string; ok: boolean }>;
}

const orgTrackingRef = (branch: string) => `refs/sync/org/${branch}`;

async function openRepos(ctx: SyncContext) {
  const org = await validateRepo(ctx.org, 'org', {});
  const intern = await validateRepo(ctx.intern, 'intern', {});
  return { org, intern };
}

/** Step 1: fetch both remotes and bring the org branch into a private ref inside the intern clone. */
async function fetchAll(ctx: SyncContext, org: { repo: GitRepo; remote: string }, intern: { repo: GitRepo; remote: string }) {
  await org.repo.fetchRemote(org.remote);
  await intern.repo.fetchRemote(intern.remote);
  await intern.repo.fetchFromUrl(ctx.org.url, `refs/heads/${ctx.org.branch}`, orgTrackingRef(ctx.org.branch));
}

function relationOf(equal: boolean, hasBase: boolean, internIsAncestor: boolean, orgIsAncestor: boolean): Relation {
  if (equal) return 'identical';
  if (!hasBase) return 'unrelated';
  if (internIsAncestor) return 'behind';
  if (orgIsAncestor) return 'ahead';
  return 'diverged';
}

export async function previewSync(
  ctx: SyncContext,
  opts: { strategy: SyncStrategy; allowUnrelatedHistories?: boolean },
): Promise<SyncPreview> {
  return withRepoLocks([ctx.org.path, ctx.intern.path], 'sync preview', async () => {
    const o = await openRepos(ctx);
    await fetchAll(ctx, o.org, o.intern);

    const repo = o.intern.repo;
    const branch = ctx.intern.branch;
    const internRef = `refs/remotes/${o.intern.remote}/${branch}`;
    const orgRef = orgTrackingRef(ctx.org.branch);
    const internSha = await repo.resolve(internRef);
    const orgSha = await repo.resolve(orgRef);
    if (!internSha) throw new AppError('REPO_INVALID', `Intern remote has no branch "${branch}".`, { hint: 'Check the target branch name.' });
    if (!orgSha) throw new AppError('REPO_INVALID', `Org remote has no branch "${ctx.org.branch}".`, { hint: 'Check the source branch name.' });

    const base = await repo.mergeBase(internSha, orgSha);
    const internIsAncestor = await repo.isAncestor(internSha, orgSha);
    const orgIsAncestor = await repo.isAncestor(orgSha, internSha);
    const relation = relationOf(internSha === orgSha, !!base, internIsAncestor, orgIsAncestor);

    const behind = relation === 'unrelated' ? [] : await repo.log(`${internSha}..${orgSha}`);
    const ahead = relation === 'unrelated' ? [] : await repo.log(`${orgSha}..${internSha}`);
    const counts = relation === 'unrelated' ? { left: 0, right: 0 } : await repo.leftRight(internSha, orgSha);

    const warnings: string[] = [];
    let conflicts: string[] = [];
    let files: FileChange[] = [];
    let diffRevs: string[] = [internSha, orgSha];

    if (opts.strategy === 'merge') {
      const mp = await repo.mergePreview(internSha, orgSha, opts.allowUnrelatedHistories);
      conflicts = mp.conflicts;
      if (mp.unrelated) {
        warnings.push('Org and intern histories are unrelated (no common ancestor). A merge needs "allow unrelated histories" and will likely conflict on shared files.');
      }
      if (base) files = await repo.diffFiles(base, orgSha);
      else files = await repo.diffFiles(internSha, orgSha);
      if (mp.tree) diffRevs = [internSha, mp.tree];
      else diffRevs = [internSha, orgSha];
    } else {
      files = await repo.diffFiles(internSha, orgSha);
    }

    const st = await repo.status();
    const currentBranch = await repo.currentBranch();
    if (!st.clean) warnings.push('Intern clone has uncommitted changes. Apply is blocked until they are committed or stashed.');
    const localSha = await repo.resolve(`refs/heads/${branch}`);
    if (localSha && localSha !== internSha && !(await repo.isAncestor(localSha, internSha))) {
      warnings.push(`Local ${branch} has commits not on the intern remote. Safe merge refuses to proceed; exact sync will back them up and drop them.`);
    }
    const id = await repo.identity();
    if (!id.name || !id.email) warnings.push('git user.name / user.email are not set in the intern clone; merge commits will fail.');

    const diff = await repo.diffText(diffRevs);
    const needsForcePush = opts.strategy === 'exact' && !internIsAncestor && internSha !== orgSha;

    return {
      strategy: opts.strategy,
      branch,
      orgSha,
      internSha,
      orgLatest: await repo.commitInfo(orgSha),
      internLatest: await repo.commitInfo(internSha),
      relation,
      behind,
      ahead,
      behindCount: counts.right,
      aheadCount: counts.left,
      files,
      conflicts,
      unrelatedHistories: relation === 'unrelated',
      needsForcePush,
      discardedCommits: opts.strategy === 'exact' ? ahead : [],
      diff,
      upToDate: opts.strategy === 'exact' ? relation === 'identical' : relation === 'identical' || relation === 'ahead',
      worktree: { clean: st.clean, currentBranch, untracked: st.untracked.length },
      warnings,
    };
  });
}

export async function applySync(
  ctx: SyncContext,
  req: {
    strategy: SyncStrategy;
    allowUnrelatedHistories?: boolean;
    expectOrgSha: string;
    expectInternSha: string;
    confirmExact?: boolean;
  },
): Promise<SyncApplyResult> {
  assertWritable(ctx.previewOnly);
  if (req.strategy === 'exact' && !req.confirmExact) {
    throw new AppError('CONFIRMATION_REQUIRED', 'Exact sync discards intern-only commits from the branch and needs explicit confirmation.', {
      hint: 'Review the list of discarded commits and confirm. A backup branch is created first.',
    });
  }
  return withRepoLocks([ctx.org.path, ctx.intern.path], 'sync apply', async () => {
    const o = await openRepos(ctx);
    const repo = o.intern.repo;
    const branch = ctx.intern.branch;
    await repo.assertCleanAndIdle();
    await fetchAll(ctx, o.org, o.intern);

    const remoteRef = `refs/remotes/${o.intern.remote}/${branch}`;
    const orgSha = await repo.resolve(orgTrackingRef(ctx.org.branch));
    const remoteSha = await repo.resolve(remoteRef);
    if (!orgSha || !remoteSha) throw new AppError('REPO_INVALID', 'Source or target branch is missing after fetch.');
    if (orgSha !== req.expectOrgSha || remoteSha !== req.expectInternSha) {
      throw new AppError('STALE', 'A remote branch moved since the preview.', {
        hint: 'Re-run the preview to review the latest changes before applying.',
        details: { orgSha, remoteSha },
      });
    }

    const orgIsAncestorOfRemote = await repo.isAncestor(orgSha, remoteSha);
    const hasBase = !!(await repo.mergeBase(remoteSha, orgSha));
    if (!hasBase && req.strategy === 'merge' && !req.allowUnrelatedHistories) {
      throw new AppError('PRECONDITION', 'Histories are unrelated; merging requires explicitly allowing unrelated histories.');
    }

    // Local branch bookkeeping (never silently discards local commits).
    const localExisted = await repo.branchExists(branch);
    let previousLocalSha = localExisted ? await repo.resolve(`refs/heads/${branch}`) : null;
    if (localExisted && previousLocalSha && previousLocalSha !== remoteSha) {
      const localBehind = await repo.isAncestor(previousLocalSha, remoteSha);
      if (!localBehind && req.strategy === 'merge') {
        throw new AppError('PRECONDITION', `Local ${branch} has commits that are not on the intern remote.`, {
          hint: `Push or move them first (e.g. git branch backup/my-work ${branch}), then retry. Exact sync can proceed because it backs them up.`,
        });
      }
    }

    const noOp = req.strategy === 'merge' ? remoteSha === orgSha || orgIsAncestorOfRemote : remoteSha === orgSha;
    if (noOp) {
      return {
        changed: false,
        strategy: req.strategy,
        branch,
        backupBranch: null,
        previousLocalSha,
        appliedSha: remoteSha,
        needsForcePush: false,
        verification: [{ check: 'Intern already up to date', ok: true }],
      };
    }

    // Recovery reference first, before anything risky. It captures the intern remote tip (what a later
    // force push could overwrite); unique unpushed local commits get their own branch.
    const backupBranch = `backup/${branch}-${stamp()}-${short(remoteSha)}`;
    await repo.createBranch(backupBranch, remoteSha, false);
    logEvent({ scope: 'intern', kind: 'info', message: `Created recovery branch ${backupBranch} at ${short(remoteSha)}` });
    if (previousLocalSha && previousLocalSha !== remoteSha && !(await repo.isAncestor(previousLocalSha, remoteSha))) {
      await repo.createBranch(`${backupBranch}-local`, previousLocalSha, false);
      logEvent({ scope: 'intern', kind: 'info', message: `Created ${backupBranch}-local at ${short(previousLocalSha)} (unpushed local commits)` });
    }

    if (!localExisted) await repo.createBranch(branch, remoteRef, true);
    else {
      if ((await repo.currentBranch()) !== branch) await repo.switchBranch(branch);
      if (previousLocalSha !== remoteSha && previousLocalSha && (await repo.isAncestor(previousLocalSha, remoteSha))) {
        await repo.fastForward(remoteSha);
      }
    }
    previousLocalSha = previousLocalSha ?? remoteSha;

    if (req.strategy === 'merge') {
      const msg = `Merge ${ctx.org.branch} from org into ${branch}`;
      const res = await repo.merge(orgSha, msg, !!req.allowUnrelatedHistories);
      if (!res.ok) {
        const op = await repo.inProgressOperation();
        if (op === 'merge') {
          const files = await repo.unmergedFiles();
          await repo.mergeAbort();
          throw new AppError('CONFLICT', `Merge conflicts in ${files.length} file(s). The merge was aborted and nothing was changed.`, {
            hint: `Resolve manually in ${ctx.intern.path}: git switch ${branch}; git merge ${orgSha.slice(0, 12)}; fix conflicts; commit. Then re-run the preview. Backup branch: ${backupBranch}.`,
            details: { files },
          });
        }
        throw new AppError('GIT', res.err.split(/\r?\n/)[0] || 'Merge failed.', { details: { backupBranch } });
      }
    } else {
      await repo.resetHard(orgSha);
    }

    const head = (await repo.resolve('HEAD'))!;
    const st = await repo.status();
    const verification =
      req.strategy === 'merge'
        ? [
            { check: 'Org commit is contained in intern branch', ok: await repo.isAncestor(orgSha, head) },
            { check: 'Previous intern commits are preserved', ok: await repo.isAncestor(remoteSha, head) },
            { check: 'Working tree is clean', ok: st.clean },
          ]
        : [
            { check: 'Branch tip equals org tip', ok: head === orgSha },
            { check: 'Trees are identical', ok: (await repo.treeOf('HEAD')) === (await repo.treeOf(orgSha)) },
            { check: 'Working tree is clean', ok: st.clean },
          ];
    const needsForcePush = !(await repo.isAncestor(remoteSha, head));
    const result: SyncApplyResult = {
      changed: true,
      strategy: req.strategy,
      branch,
      backupBranch,
      previousLocalSha,
      appliedSha: head,
      needsForcePush,
      verification,
    };
    putSyncRecord({
      phase: 'applied',
      strategy: req.strategy,
      branch,
      backupBranch,
      previousLocalSha,
      expectedRemoteSha: remoteSha,
      orgSha,
      appliedSha: head,
      needsForcePush,
    });
    if (verification.some((v) => !v.ok)) {
      throw new AppError('GIT', 'Post-sync verification failed; do not push.', {
        hint: `Roll back with: git switch ${branch}; git reset --hard ${backupBranch}`,
        details: { verification },
      });
    }
    return result;
  });
}

export async function pushSync(
  ctx: SyncContext,
  req: { expectHeadSha: string; confirmPush: true; confirmForcePush?: boolean },
): Promise<{ pushedSha: string; forced: boolean; verifiedRemoteSha: string | null }> {
  assertWritable(ctx.previewOnly);
  return withRepoLocks([ctx.intern.path], 'sync push', async () => {
    const o = await validateRepo(ctx.intern, 'intern', {});
    const repo = o.repo;
    const branch = ctx.intern.branch;
    const rec = getSyncRecord();
    if (!rec || rec.phase !== 'applied' || rec.branch !== branch) {
      throw new AppError('PRECONDITION', 'There is no applied sync waiting to be pushed.', { hint: 'Run Apply first.' });
    }
    if (branch === '' || (await repo.currentBranch()) !== branch) {
      throw new AppError('PRECONDITION', `Intern clone is not on ${branch}.`, { hint: `git switch ${branch}` });
    }
    const head = await repo.resolve('HEAD');
    if (head !== req.expectHeadSha || head !== rec.appliedSha) {
      throw new AppError('STALE', 'The local branch changed since it was applied/reviewed.', { hint: 'Re-run the sync from the preview.' });
    }
    await repo.assertCleanAndIdle();

    // Fresh remote verification immediately before writing.
    await repo.fetchRemote(o.remote);
    const remoteSha = await repo.resolve(`refs/remotes/${o.remote}/${branch}`);
    if (remoteSha !== rec.expectedRemoteSha) {
      throw new AppError('STALE', 'The intern remote branch moved after the sync was prepared; refusing to push.', {
        hint: `Re-run the preview. Your local result is kept; backup: ${rec.backupBranch}.`,
        details: { remoteSha },
      });
    }
    const needsForce = !(await repo.isAncestor(remoteSha, head));
    if (needsForce && !req.confirmForcePush) {
      throw new AppError('CONFIRMATION_REQUIRED', 'This push rewrites remote history and needs explicit force-push confirmation.', {
        hint: 'Confirm the force push (uses --force-with-lease against the fetched remote tip).',
        details: { needsForce: true },
      });
    }
    await repo.push(o.remote, 'HEAD', branch, { forceWithLeaseSha: needsForce ? remoteSha : undefined });
    const verified = await repo.lsRemoteHead(o.remote, branch);
    if (verified !== head) {
      throw new AppError('GIT', 'Push finished but the remote tip does not match the local branch.', { details: { verified } });
    }
    putSyncRecord({ ...rec, phase: 'pushed', appliedSha: head }, { lastSyncAt: new Date().toISOString() });
    return { pushedSha: head, forced: needsForce, verifiedRemoteSha: verified };
  });
}

/** Undo an applied-but-unpushed sync by resetting the local branch to its backup. */
export async function rollbackSync(ctx: SyncContext, req: { confirm: true }): Promise<{ restoredSha: string }> {
  void req;
  assertWritable(ctx.previewOnly);
  return withRepoLocks([ctx.intern.path], 'sync rollback', async () => {
    const o = await validateRepo(ctx.intern, 'intern', {});
    const rec = getSyncRecord();
    if (!rec || rec.phase !== 'applied') {
      throw new AppError('PRECONDITION', 'Nothing to roll back: no applied, unpushed sync recorded.');
    }
    await o.repo.assertCleanAndIdle();
    if ((await o.repo.currentBranch()) !== rec.branch) await o.repo.switchBranch(rec.branch);
    await o.repo.resetHard(rec.backupBranch);
    clearSyncRecord();
    return { restoredSha: (await o.repo.resolve('HEAD'))! };
  });
}
