import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import { getSyncRecord } from '@/server/state';
import { applySync, previewSync, pushSync, rollbackSync } from '@/server/workflows/sync';
import { commitFile, git, makeScenario, write, type Scenario } from './helpers/repos';

let sc: Scenario;
beforeEach(() => {
  sc = makeScenario();
});
afterEach(() => sc.cleanup());

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err, `expected AppError ${code}`).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

async function previewAndApply(strategy: 'merge' | 'exact', extra: { confirmExact?: boolean } = {}) {
  const pv = await previewSync(sc.ctx(), { strategy });
  const res = await applySync(sc.ctx(), {
    strategy,
    expectOrgSha: pv.orgSha,
    expectInternSha: pv.internSha,
    ...extra,
  });
  return { pv, res };
}

describe('sync preview', () => {
  it('shows org develop advancing while intern is behind', async () => {
    const orgSha = sc.advance('org', 'src/new.txt', 'hello\n', 'org: add new file');
    sc.advance('org', 'README.md', '# project v2\n', 'org: update readme');
    const pv = await previewSync(sc.ctx(), { strategy: 'merge' });
    expect(pv.relation).toBe('behind');
    expect(pv.behindCount).toBe(2);
    expect(pv.aheadCount).toBe(0);
    expect(pv.files.map((f) => f.path).sort()).toEqual(['README.md', 'src/new.txt']);
    expect(pv.conflicts).toEqual([]);
    expect(pv.diff.text).toContain('src/new.txt');
    expect(pv.orgLatest?.subject).toBe('org: update readme');
    expect(pv.orgSha).not.toBe(orgSha);
    expect(pv.needsForcePush).toBe(false);
  });

  it('predicts conflicts without touching the working tree', async () => {
    sc.advance('org', 'src/app.txt', 'line1\nORG\nline3\n', 'org edits line2');
    sc.advance('intern', 'src/app.txt', 'line1\nINTERN\nline3\n', 'intern edits line2');
    const pv = await previewSync(sc.ctx(), { strategy: 'merge' });
    expect(pv.relation).toBe('diverged');
    expect(pv.conflicts).toEqual(['src/app.txt']);
    expect(git(sc.internClone, 'status', '--porcelain')).toBe('');
  });

  it('reports uncommitted changes as a warning', async () => {
    write(sc.internClone, 'README.md', 'dirty\n');
    const pv = await previewSync(sc.ctx(), { strategy: 'merge' });
    expect(pv.worktree.clean).toBe(false);
    expect(pv.warnings.join(' ')).toMatch(/uncommitted/i);
  });

  it('detects unrelated histories', async () => {
    sc.cleanup();
    sc = makeScenario({ sharedHistory: false });
    const pv = await previewSync(sc.ctx(), { strategy: 'merge' });
    expect(pv.relation).toBe('unrelated');
    expect(pv.unrelatedHistories).toBe(true);
    await expectCode(
      applySync(sc.ctx(), { strategy: 'merge', expectOrgSha: pv.orgSha, expectInternSha: pv.internSha }),
      'PRECONDITION',
    );
  });
});

describe('safe merge', () => {
  it('fast-forwards a behind intern and pushes without force', async () => {
    const orgSha = sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    const { res } = await previewAndApply('merge');
    expect(res.changed).toBe(true);
    expect(res.verification.every((v) => v.ok)).toBe(true);
    expect(res.needsForcePush).toBe(false);
    expect(res.appliedSha).toBe(orgSha);
    expect(res.backupBranch).toMatch(/^backup\/develop-/);

    const push = await pushSync(sc.ctx(), { expectHeadSha: res.appliedSha, confirmPush: true });
    expect(push.forced).toBe(false);
    expect(git(sc.internBare, 'rev-parse', 'develop')).toBe(orgSha);
    expect(getSyncRecord()?.phase).toBe('pushed');
  });

  it('preserves intern-only commits via a merge commit', async () => {
    const internOnly = sc.advance('intern', 'intern-notes.txt', 'mine\n', 'intern: notes');
    const orgSha = sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    const { pv, res } = await previewAndApply('merge');
    expect(pv.relation).toBe('diverged');
    expect(pv.conflicts).toEqual([]);
    expect(res.needsForcePush).toBe(false);
    const head = git(sc.internClone, 'rev-parse', 'HEAD');
    expect(git(sc.internClone, 'merge-base', '--is-ancestor', internOnly, head) === '').toBe(true);
    expect(git(sc.internClone, 'merge-base', '--is-ancestor', orgSha, head) === '').toBe(true);
    expect(fs.existsSync(path.join(sc.internClone, 'intern-notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(sc.internClone, 'src/new.txt'))).toBe(true);

    await pushSync(sc.ctx(), { expectHeadSha: head, confirmPush: true });
    expect(git(sc.internBare, 'rev-parse', 'develop')).toBe(head);
  });

  it('aborts cleanly on conflicts and keeps the branch untouched', async () => {
    sc.advance('org', 'src/app.txt', 'line1\nORG\nline3\n', 'org edits');
    const internSha = sc.advance('intern', 'src/app.txt', 'line1\nINTERN\nline3\n', 'intern edits');
    const pv = await previewSync(sc.ctx(), { strategy: 'merge' });
    const err = await expectCode(
      applySync(sc.ctx(), { strategy: 'merge', expectOrgSha: pv.orgSha, expectInternSha: pv.internSha }),
      'CONFLICT',
    );
    expect(err.details?.files).toEqual(['src/app.txt']);
    expect(git(sc.internClone, 'status', '--porcelain')).toBe('');
    expect(git(sc.internClone, 'rev-parse', 'HEAD')).toBe(internSha);
    expect(fs.existsSync(path.join(sc.internClone, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('refuses to run with uncommitted changes and preserves them', async () => {
    sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    const pv = await previewSync(sc.ctx(), { strategy: 'merge' });
    write(sc.internClone, 'README.md', 'my unsaved work\n');
    await expectCode(
      applySync(sc.ctx(), { strategy: 'merge', expectOrgSha: pv.orgSha, expectInternSha: pv.internSha }),
      'DIRTY_WORKTREE',
    );
    expect(fs.readFileSync(path.join(sc.internClone, 'README.md'), 'utf8')).toBe('my unsaved work\n');
  });

  it('refuses to apply when a remote moved since the preview (stale)', async () => {
    sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    const pv = await previewSync(sc.ctx(), { strategy: 'merge' });
    sc.advance('org', 'src/newer.txt', 'again\n', 'org: add more');
    await expectCode(
      applySync(sc.ctx(), { strategy: 'merge', expectOrgSha: pv.orgSha, expectInternSha: pv.internSha }),
      'STALE',
    );
  });

  it('is a no-op when intern already contains org', async () => {
    const pv = await previewSync(sc.ctx(), { strategy: 'merge' });
    expect(pv.upToDate).toBe(true);
    const res = await applySync(sc.ctx(), { strategy: 'merge', expectOrgSha: pv.orgSha, expectInternSha: pv.internSha });
    expect(res.changed).toBe(false);
  });
});

describe('exact sync', () => {
  it('requires explicit confirmation', async () => {
    sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    const pv = await previewSync(sc.ctx(), { strategy: 'exact' });
    await expectCode(
      applySync(sc.ctx(), { strategy: 'exact', expectOrgSha: pv.orgSha, expectInternSha: pv.internSha }),
      'CONFIRMATION_REQUIRED',
    );
  });

  it('lists discarded commits, creates a backup ref, and needs force-with-lease to push', async () => {
    const internOnly = sc.advance('intern', 'intern-notes.txt', 'mine\n', 'intern: notes');
    const orgSha = sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');

    const pv = await previewSync(sc.ctx(), { strategy: 'exact' });
    expect(pv.discardedCommits.map((c) => c.sha)).toEqual([internOnly]);
    expect(pv.needsForcePush).toBe(true);

    const res = await applySync(sc.ctx(), {
      strategy: 'exact',
      expectOrgSha: pv.orgSha,
      expectInternSha: pv.internSha,
      confirmExact: true,
    });
    expect(res.appliedSha).toBe(orgSha);
    expect(res.needsForcePush).toBe(true);
    expect(res.backupBranch).toBeTruthy();
    expect(git(sc.internClone, 'rev-parse', res.backupBranch!)).toBe(internOnly); // recoverable
    expect(git(sc.internClone, 'rev-parse', 'HEAD^{tree}')).toBe(git(sc.orgBare, 'rev-parse', 'develop^{tree}'));

    await expectCode(pushSync(sc.ctx(), { expectHeadSha: res.appliedSha, confirmPush: true }), 'CONFIRMATION_REQUIRED');
    expect(git(sc.internBare, 'rev-parse', 'develop')).toBe(internOnly); // nothing was pushed

    const push = await pushSync(sc.ctx(), { expectHeadSha: res.appliedSha, confirmPush: true, confirmForcePush: true });
    expect(push.forced).toBe(true);
    expect(git(sc.internBare, 'rev-parse', 'develop')).toBe(orgSha);
  });

  it('refuses the push when the intern remote moved after apply (stale lease)', async () => {
    sc.advance('intern', 'intern-notes.txt', 'mine\n', 'intern: notes');
    sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    const { res } = await previewAndApply('exact', { confirmExact: true });
    const moved = sc.advance('intern', 'late.txt', 'late\n', 'intern: late commit');
    await expectCode(
      pushSync(sc.ctx(), { expectHeadSha: res.appliedSha, confirmPush: true, confirmForcePush: true }),
      'STALE',
    );
    expect(git(sc.internBare, 'rev-parse', 'develop')).toBe(moved);
  });

  it('can roll back an applied, unpushed sync to the backup branch', async () => {
    const internOnly = sc.advance('intern', 'intern-notes.txt', 'mine\n', 'intern: notes');
    sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    await previewAndApply('exact', { confirmExact: true });
    const r = await rollbackSync(sc.ctx(), { confirm: true });
    expect(r.restoredSha).toBe(internOnly);
    expect(getSyncRecord()).toBeUndefined();
  });
});

describe('safety rails', () => {
  it('blocks every write while preview-only mode is on', async () => {
    sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    const pv = await previewSync(sc.ctx(true), { strategy: 'merge' });
    await expectCode(
      applySync(sc.ctx(true), { strategy: 'merge', expectOrgSha: pv.orgSha, expectInternSha: pv.internSha }),
      'PREVIEW_ONLY',
    );
    await expectCode(pushSync(sc.ctx(true), { expectHeadSha: pv.orgSha, confirmPush: true }), 'PREVIEW_ONLY');
  });

  it('maps a server-side push rejection to REMOTE_REJECTED and leaves the local result intact', async () => {
    sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    const { res } = await previewAndApply('merge');
    const hook = path.join(sc.internBare, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "protected branch: push declined" >&2\nexit 1\n', { mode: 0o755 });
    await expectCode(pushSync(sc.ctx(), { expectHeadSha: res.appliedSha, confirmPush: true }), 'REMOTE_REJECTED');
    expect(git(sc.internClone, 'rev-parse', 'HEAD')).toBe(res.appliedSha);
  });

  it('rejects pushing a different commit than the one reviewed', async () => {
    sc.advance('org', 'src/new.txt', 'hello\n', 'org: add');
    const { res } = await previewAndApply('merge');
    commitFile(sc.internClone, 'sneaky.txt', 'x\n', 'local extra commit');
    await expectCode(pushSync(sc.ctx(), { expectHeadSha: res.appliedSha, confirmPush: true }), 'STALE');
  });

  it('rejects a clone whose remote does not match the configured URL (identity check)', async () => {
    const ctx = sc.ctx();
    ctx.intern.url = sc.orgBare; // wrong repo for the intern clone
    await expectCode(previewSync(ctx, { strategy: 'merge' }), 'REPO_INVALID');
  });

  it('rejects a missing path and a non-repository path', async () => {
    const ctx = sc.ctx();
    ctx.intern.path = path.join(sc.root, 'nope');
    await expectCode(previewSync(ctx, { strategy: 'merge' }), 'REPO_INVALID');
    const plain = path.join(sc.root, 'plain');
    fs.mkdirSync(plain);
    ctx.intern.path = plain;
    await expectCode(previewSync(ctx, { strategy: 'merge' }), 'REPO_INVALID');
  });

  it('surfaces an unreachable org remote as a categorized error', async () => {
    const ctx = sc.ctx();
    fs.rmSync(sc.orgBare, { recursive: true, force: true });
    const err = await previewSync(ctx, { strategy: 'merge' }).catch((e) => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect(['NOT_FOUND', 'NETWORK', 'AUTH']).toContain((err as AppError).code);
  });
});
