'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { AppConfig, SyncApplyResult, SyncPreview } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { CommitList, FileList } from './CommitFileLists';
import { DiffView } from './DiffView';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorBox, Sha, Spinner, Stepper } from './ui';

const STEPS = ['Fetch & compare', 'Review changes', 'Apply locally', 'Verify & push', 'Done'];
type Strategy = 'merge' | 'exact';
type Dialog = null | 'apply' | 'push' | 'rollback';

const RELATION_TEXT: Record<SyncPreview['relation'], string> = {
  identical: 'Identical: nothing to sync.',
  behind: 'Intern is behind org (fast-forward possible).',
  ahead: 'Intern is ahead of org (org is already contained).',
  diverged: 'Diverged: both sides have unique commits.',
  unrelated: 'Unrelated histories: no common ancestor.',
};

export function SyncWorkflow({ config, onDone }: { config: AppConfig; onDone: () => void }) {
  const [strategy, setStrategy] = useState<Strategy>(config.preferences.syncStrategy);
  const [allowUnrelated, setAllowUnrelated] = useState(false);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [applied, setApplied] = useState<SyncApplyResult | null>(null);
  const [pushed, setPushed] = useState<{ pushedSha: string; forced: boolean } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { busy, error, run } = useAsync();
  const writable = !config.preferences.previewOnly;

  const step = pushed ? 4 : applied ? 3 : preview ? 1 : 0;

  const doPreview = (s: Strategy = strategy, unrelated = allowUnrelated) =>
    run('Fetching and comparing', async () => {
      setApplied(null);
      setPushed(null);
      setPreview(await api<SyncPreview>('POST', 'sync/preview', { strategy: s, allowUnrelatedHistories: unrelated }));
    });

  const doApply = () =>
    run('Applying locally', async () => {
      if (!preview) return;
      try {
        setApplied(
          await api<SyncApplyResult>('POST', 'sync/apply', {
            strategy,
            allowUnrelatedHistories: allowUnrelated,
            expectOrgSha: preview.orgSha,
            expectInternSha: preview.internSha,
            confirmExact: strategy === 'exact',
          }),
        );
      } finally {
        setDialog(null);
      }
    });

  const doPush = (force: boolean) =>
    run('Pushing to the intern remote', async () => {
      if (!applied) return;
      try {
        setPushed(await api('POST', 'sync/push', { expectHeadSha: applied.appliedSha, confirmPush: true, confirmForcePush: force }));
        onDone();
      } finally {
        setDialog(null);
      }
    });

  const doRollback = () =>
    run('Rolling back', async () => {
      try {
        await api('POST', 'sync/rollback', { confirm: true });
        setApplied(null);
        onDone();
        await doPreview();
      } finally {
        setDialog(null);
      }
    });

  const blockedByConflicts = strategy === 'merge' && !!preview && preview.conflicts.length > 0;
  const canApply = !!preview && writable && !preview.upToDate && preview.worktree.clean && !blockedByConflicts && (!preview.unrelatedHistories || allowUnrelated || strategy === 'exact');

  return (
    <div className="space-y-4">
      <Stepper steps={STEPS} current={step} />

      <Card title="1 · Strategy">
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="radio" checked={strategy === 'merge'} onChange={() => { setStrategy('merge'); if (preview) void doPreview('merge'); }} disabled={!!applied} />
            <span>
              <b>Safe merge</b> — merge org <code>{config.org.branch}</code> into intern <code>{config.intern.branch}</code>; intern-only commits are preserved. Never needs a force push.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={strategy === 'exact'} onChange={() => { setStrategy('exact'); if (preview) void doPreview('exact'); }} disabled={!!applied} />
            <span>
              <b>Exact sync</b> — make intern identical to org. <span className="text-rose-300">Discards intern-only commits</span> from the branch (backed up locally first); may require a force push.
            </span>
          </label>
          <label className="flex items-center gap-2 text-slate-400">
            <input type="checkbox" checked={allowUnrelated} onChange={(e) => setAllowUnrelated(e.target.checked)} disabled={!!applied} />
            Allow unrelated histories (only if the repos were created independently)
          </label>
          <div className="flex items-center gap-3 pt-1">
            <Button variant="primary" onClick={() => doPreview()} disabled={!!busy || !!applied}>
              Fetch both remotes &amp; compare
            </Button>
            {busy && <Spinner label={busy} />}
          </div>
        </div>
      </Card>

      <ErrorBox error={error} />

      {preview && (
        <>
          <Card
            title="2 · Comparison"
            actions={<Badge tone={preview.upToDate ? 'good' : preview.conflicts.length ? 'bad' : 'info'}>{RELATION_TEXT[preview.relation]}</Badge>}
          >
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <div className="text-xs text-slate-500">org {preview.branch} (source of truth)</div>
                <Sha sha={preview.orgSha} /> {preview.orgLatest?.subject}
              </div>
              <div>
                <div className="text-xs text-slate-500">intern {preview.branch}</div>
                <Sha sha={preview.internSha} /> {preview.internLatest?.subject}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-6 text-sm">
              <span>
                <b className="text-xl text-amber-300">{preview.behindCount}</b> behind (org commits intern lacks)
              </span>
              <span>
                <b className="text-xl text-sky-300">{preview.aheadCount}</b> ahead (intern-only)
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {preview.warnings.map((w) => (
                <Alert key={w} tone="warn">
                  {w}
                </Alert>
              ))}
              {preview.conflicts.length > 0 && strategy === 'merge' && (
                <Alert tone="bad" title={`Potential conflicts in ${preview.conflicts.length} file(s)`}>
                  <p className="font-mono text-xs">{preview.conflicts.join(', ')}</p>
                  <p>Apply is blocked. Resolve manually in the intern clone (merge org develop, fix, commit) or choose exact sync if intern-only work can be dropped.</p>
                </Alert>
              )}
              {strategy === 'exact' && preview.discardedCommits.length > 0 && (
                <Alert tone="bad" title={`Exact sync would discard ${preview.discardedCommits.length} intern-only commit(s)`}>
                  <CommitList commits={preview.discardedCommits} />
                </Alert>
              )}
              {preview.needsForcePush && (
                <Alert tone="warn" title="Remote history rewrite">
                  After applying, pushing requires <code>--force-with-lease</code> and a separate confirmation.
                </Alert>
              )}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`Org commits to bring in (${preview.behind.length})`}>
              <CommitList commits={preview.behind} empty="Intern already has everything from org." />
            </Card>
            <Card title={`Intern-only commits (${preview.ahead.length})`}>
              <CommitList commits={preview.ahead} empty="No intern-only commits." />
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`Changed files (${preview.files.length})`}>
              <FileList files={preview.files} />
            </Card>
            <Card title="Preview of resulting changes (intern before → after)">
              <DiffView text={preview.diff.text} truncated={preview.diff.truncated} />
            </Card>
          </div>

          {!applied && (
            <Card title="3 · Apply locally (no remote write yet)">
              <div className="flex flex-wrap items-center gap-3">
                <Button variant={strategy === 'exact' ? 'danger' : 'primary'} onClick={() => setDialog('apply')} disabled={!canApply || !!busy}>
                  {strategy === 'merge' ? 'Apply safe merge locally' : 'Apply exact sync locally'}
                </Button>
                {!writable && <span className="text-xs text-amber-300">Preview-only mode is on (Setup → Review).</span>}
                {preview.upToDate && <span className="text-xs text-emerald-300">Already up to date.</span>}
                {!preview.worktree.clean && <span className="text-xs text-amber-300">Uncommitted changes in the intern clone.</span>}
              </div>
            </Card>
          )}
        </>
      )}

      {applied && (
        <Card title="4 · Verification" actions={<Badge tone={applied.verification.every((v) => v.ok) ? 'good' : 'bad'}>{applied.changed ? 'applied locally' : 'no change'}</Badge>}>
          <ul className="space-y-1 text-sm">
            {applied.verification.map((v) => (
              <li key={v.check} className="flex gap-2">
                <span className={v.ok ? 'text-emerald-400' : 'text-rose-400'}>{v.ok ? '✓' : '✗'}</span>
                {v.check}
              </li>
            ))}
          </ul>
          {applied.backupBranch && (
            <p className="mt-2 text-sm text-slate-400">
              Recovery branch: <code className="text-sky-300">{applied.backupBranch}</code> (local)
            </p>
          )}
          <p className="mt-1 text-sm">
            New intern <code>{applied.branch}</code> tip: <Sha sha={applied.appliedSha} />
          </p>
          {!pushed && applied.changed && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant={applied.needsForcePush ? 'danger' : 'primary'} onClick={() => setDialog('push')} disabled={!!busy}>
                {applied.needsForcePush ? 'Force-push (with lease) to intern…' : 'Push to intern remote…'}
              </Button>
              <Button onClick={() => setDialog('rollback')} disabled={!!busy}>
                Roll back local result
              </Button>
            </div>
          )}
          {!applied.changed && <p className="mt-2 text-sm text-emerald-300">Intern was already up to date; nothing to push.</p>}
        </Card>
      )}

      {pushed && (
        <Alert tone="good" title="Sync complete">
          Intern <code>{config.intern.branch}</code> is now at <Sha sha={pushed.pushedSha} /> {pushed.forced ? '(history rewritten with --force-with-lease)' : '(fast-forward push)'}. The remote tip was re-verified after the push.
        </Alert>
      )}

      <ConfirmDialog
        open={dialog === 'apply'}
        title={strategy === 'merge' ? 'Apply safe merge locally?' : 'Apply exact sync locally?'}
        confirmLabel={strategy === 'merge' ? 'Apply merge' : 'Discard & apply'}
        danger={strategy === 'exact'}
        requirePhrase={strategy === 'exact' ? 'DISCARD' : undefined}
        busy={!!busy}
        onConfirm={doApply}
        onCancel={() => setDialog(null)}
      >
        {strategy === 'merge' ? (
          <p>
            A recovery branch is created, then org <code>{config.org.branch}</code> is merged into local intern <code>{config.intern.branch}</code>. Nothing is pushed yet.
          </p>
        ) : (
          <>
            <p>
              Local intern <code>{config.intern.branch}</code> will be <b>reset to org</b>, discarding {preview?.discardedCommits.length ?? 0} intern-only commit(s) from the branch. A local recovery branch is created first.
            </p>
            <p>Nothing is pushed yet.</p>
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'push'}
        title={applied?.needsForcePush ? 'Rewrite intern remote history?' : 'Push to the intern remote?'}
        confirmLabel={applied?.needsForcePush ? 'Force push with lease' : 'Push'}
        danger={applied?.needsForcePush}
        requirePhrase={applied?.needsForcePush ? 'FORCE PUSH' : undefined}
        busy={!!busy}
        onConfirm={() => doPush(!!applied?.needsForcePush)}
        onCancel={() => setDialog(null)}
      >
        <p>
          This writes to the <b>intern remote</b> branch <code>{config.intern.branch}</code> (<Sha sha={applied?.appliedSha} />).
        </p>
        {applied?.needsForcePush ? (
          <p className="text-rose-300">
            It rewrites remote history using <code>--force-with-lease</code>. The remote is fetched again first and the push is refused if anyone pushed in the meantime. Discarded commits stay reachable from the backup branch only locally.
          </p>
        ) : (
          <p>It is a normal fast-forward push; the remote is re-checked first.</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog open={dialog === 'rollback'} title="Roll back the local result?" confirmLabel="Roll back" busy={!!busy} onConfirm={doRollback} onCancel={() => setDialog(null)}>
        <p>
          Resets local intern <code>{config.intern.branch}</code> to the recovery branch. The remote is untouched.
        </p>
      </ConfirmDialog>
    </div>
  );
}
