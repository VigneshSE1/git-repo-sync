'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AppConfig, PrRow, PublishResult, TransferOutcome, TransferPlan, TransferReview } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { CommitList, FileList } from './CommitFileLists';
import { DiffView } from './DiffView';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorBox, Sha, Spinner, Stepper } from './ui';

const STEPS = ['Select PR', 'Review commits', 'Transfer', 'Review result', 'Publish', 'Done'];
type Filter = 'open' | 'merged' | 'all';

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  ready: 'good',
  merge: 'warn',
  'already-in-org': 'neutral',
  'equivalent-in-org': 'neutral',
  'already-transferred': 'neutral',
  'not-in-head': 'bad',
  missing: 'bad',
};

export function TransferWorkflow({ config, onDone }: { config: AppConfig; onDone: () => void }) {
  const manual = config.preferences.prDiscovery === 'manual';
  const writable = !config.preferences.previewOnly;
  const [filter, setFilter] = useState<Filter>('open');
  const [prs, setPrs] = useState<PrRow[] | null>(null);
  const [manualInput, setManualInput] = useState('');
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<'cherry-pick' | 'patch'>('cherry-pick');
  const [allowRepeat, setAllowRepeat] = useState(false);
  const [outcome, setOutcome] = useState<TransferOutcome | null>(null);
  const [review, setReview] = useState<TransferReview | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const { busy, error, run } = useAsync();

  const loadPrs = useCallback(
    (f: Filter) =>
      run('Loading pull requests', async () => {
        const r = await api<{ prs: PrRow[] }>('GET', `transfer/prs?state=${f}`);
        setPrs(r.prs);
      }),
    [run],
  );

  useEffect(() => {
    if (!manual) void loadPrs(filter);
  }, [manual, filter, loadPrs]);

  const reset = () => {
    setPlan(null);
    setOutcome(null);
    setReview(null);
    setPublished(null);
    setSelected(new Set());
  };

  const choose = (prNumber: number) =>
    run('Fetching PR head and analysing commits', async () => {
      reset();
      const p = await api<TransferPlan>('POST', 'transfer/plan', { prNumber });
      setPlan(p);
      setStrategy(p.recommendedStrategy);
      setSelected(new Set(p.commits.filter((c) => c.selectable).map((c) => c.sha)));
    });

  const loadReview = (prNumber: number) =>
    run('Loading review', async () => {
      setReview(await api<TransferReview>('POST', 'transfer/review', { prNumber }));
    });

  const start = () =>
    run('Creating transfer branch and applying', async () => {
      if (!plan) return;
      const out = await api<TransferOutcome>('POST', 'transfer/start', {
        prNumber: plan.pr.number,
        strategy,
        commits: plan.commits.filter((c) => selected.has(c.sha)).map((c) => c.sha),
        allowRepeat,
      });
      setOutcome(out);
      onDone();
      if (out.status === 'ready-for-review') setReview(await api<TransferReview>('POST', 'transfer/review', { prNumber: plan.pr.number }));
    });

  const resume = (action: 'continue' | 'abort') =>
    run(action === 'continue' ? 'Continuing' : 'Aborting', async () => {
      if (!plan) return;
      try {
        const out = await api<TransferOutcome>('POST', 'transfer/resume', { prNumber: plan.pr.number, action });
        setOutcome(out);
        onDone();
        if (out.status === 'ready-for-review') setReview(await api<TransferReview>('POST', 'transfer/review', { prNumber: plan.pr.number }));
        if (out.status === 'aborted') {
          setReview(null);
          setOutcome(null);
        }
      } finally {
        setConfirmAbort(false);
      }
    });

  const publish = () =>
    run('Pushing branch and creating the org PR', async () => {
      if (!plan || !review?.record.tip) return;
      try {
        setPublished(await api<PublishResult>('POST', 'transfer/publish', { prNumber: plan.pr.number, expectTip: review.record.tip, confirmPush: true }));
        onDone();
      } finally {
        setConfirmPublish(false);
      }
    });

  const inConflict = outcome?.status === 'conflict' || plan?.existing?.status === 'conflict';
  const step = published ? 5 : review ? 3 : outcome ? 2 : plan ? 1 : 0;
  const existing = plan?.existing && plan.existing.status !== 'aborted' ? plan.existing : null;
  const selectedCount = selected.size;
  const canStart = !!plan && writable && !busy && !existing?.status.match(/in-progress|conflict|ready-for-review/) && (strategy === 'patch' || selectedCount > 0);

  return (
    <div className="space-y-4">
      <Stepper steps={STEPS} current={step} />
      <ErrorBox error={error} />
      {busy && <Spinner label={busy} />}

      {!plan && (
        <Card
          title="1 · Select an intern pull request"
          actions={
            !manual && (
              <>
                {(['open', 'merged', 'all'] as Filter[]).map((f) => (
                  <Button key={f} variant={filter === f ? 'primary' : 'ghost'} onClick={() => setFilter(f)}>
                    {f}
                  </Button>
                ))}
              </>
            )
          }
        >
          {manual && (
            <div className="flex gap-2">
              <input type="text" value={manualInput} onChange={(e) => setManualInput(e.target.value)} placeholder="https://github.com/<owner>/<repo>/pull/123  or  123" />
              <Button
                variant="primary"
                disabled={!manualInput.trim() || !!busy}
                onClick={() => {
                  const m = /\/pull\/(\d+)/.exec(manualInput) ?? /^#?(\d+)$/.exec(manualInput.trim());
                  if (m) void choose(Number(m[1]));
                }}
              >
                Analyse
              </Button>
            </div>
          )}
          {!manual && prs && prs.length === 0 && <p className="text-sm text-slate-500">No {filter} pull requests found.</p>}
          {!manual && prs && prs.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-1">#</th>
                  <th>Title</th>
                  <th>Author</th>
                  <th>Source → target</th>
                  <th>Status</th>
                  <th>Commits</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {prs.map((p) => (
                  <tr key={p.number}>
                    <td className="py-1.5">{p.number}</td>
                    <td className="max-w-xs truncate">{p.title}</td>
                    <td>{p.author}</td>
                    <td className="font-mono text-xs">
                      {p.sourceBranch} → {p.targetBranch}
                    </td>
                    <td className="space-x-1">
                      <Badge tone={p.state === 'merged' ? 'info' : 'good'}>{p.state}</Badge>
                      {p.transfer && <Badge tone={p.transfer === 'pr-created' ? 'good' : 'warn'}>transfer: {p.transfer}</Badge>}
                    </td>
                    <td>{p.commitCount}</td>
                    <td className="text-right">
                      <Button onClick={() => choose(p.number)} disabled={!!busy}>
                        Select
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {plan && (
        <>
          <Card
            title={`PR #${plan.pr.number} · ${plan.pr.title}`}
            actions={
              <>
                <Badge tone={plan.pr.state === 'merged' ? 'info' : 'good'}>{plan.pr.state}</Badge>
                <Button variant="ghost" onClick={reset} disabled={!!busy || (!!outcome && !review && outcome.status === 'conflict')}>
                  Choose another
                </Button>
              </>
            }
          >
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                Author: <b>{plan.pr.author}</b>
              </div>
              <div className="font-mono text-xs">
                {plan.pr.sourceBranch} → {plan.pr.targetBranch}
              </div>
              <div>
                Fetched head: <Sha sha={plan.fetchedHeadSha} />
              </div>
              <div>
                Org {config.org.branch}: <Sha sha={plan.orgSha} /> → new branch <code>{plan.branchName}</code>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {plan.warnings.map((w) => (
                <Alert key={w} tone="warn">
                  {w}
                </Alert>
              ))}
              {plan.strategyReasons.length > 0 && (
                <Alert tone="warn" title="Commit-level transfer is not suitable">
                  <ul className="list-disc pl-4">
                    {plan.strategyReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p>A reviewed patch-based transfer (one combined commit) is recommended.</p>
                </Alert>
              )}
              {existing && (
                <Alert tone="info" title={`A transfer already exists: ${existing.status}`}>
                  <p>
                    Branch <code>{existing.branch}</code>
                    {existing.orgPrUrl && (
                      <>
                        {' '}
                        · org PR: <code>{existing.orgPrUrl}</code>
                      </>
                    )}
                  </p>
                  {(existing.status === 'ready-for-review' || existing.status === 'pushed') && !review && (
                    <Button onClick={() => loadReview(plan.pr.number)} disabled={!!busy}>
                      Open review
                    </Button>
                  )}
                  {(existing.status === 'pushed' || existing.status === 'pr-created') && (
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={allowRepeat} onChange={(e) => setAllowRepeat(e.target.checked)} />
                      Allow a repeat transfer on a new branch (not recommended)
                    </label>
                  )}
                </Alert>
              )}
            </div>
          </Card>

          {!outcome && !review && (
            <>
              <Card title={`2 · Commits (${plan.commits.length})`}>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-slate-500">
                    <tr>
                      <th className="w-8" />
                      <th>Commit</th>
                      <th>Author</th>
                      <th>Files</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {plan.commits.map((c) => (
                      <tr key={c.sha} className={c.selectable ? '' : 'opacity-70'}>
                        <td className="py-1.5">
                          <input
                            type="checkbox"
                            disabled={!c.selectable || strategy === 'patch'}
                            checked={strategy === 'cherry-pick' && selected.has(c.sha)}
                            onChange={(e) =>
                              setSelected((s) => {
                                const n = new Set(s);
                                if (e.target.checked) n.add(c.sha);
                                else n.delete(c.sha);
                                return n;
                              })
                            }
                          />
                        </td>
                        <td>
                          <Sha sha={c.sha} /> {c.subject}
                          {c.note && <div className="text-xs text-slate-500">{c.note}</div>}
                        </td>
                        <td className="text-xs text-slate-400">{c.author}</td>
                        <td className="text-xs text-slate-400">{c.files.length}</td>
                        <td>
                          <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
                        </td>
                      </tr>
                    ))}
                    {plan.commits.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-3 text-slate-500">
                          No commits reported (use the patch strategy).
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>
              <Card title={`Changed files in the PR (${plan.files.length})`}>
                <FileList files={plan.files} />
              </Card>
              <Card title="3 · Transfer strategy">
                <div className="space-y-2 text-sm">
                  <label className="flex items-start gap-2">
                    <input type="radio" checked={strategy === 'cherry-pick'} onChange={() => setStrategy('cherry-pick')} />
                    <span>
                      <b>Cherry-pick</b> the selected commits in PR order (<code>-x</code> records the original SHA). Stops on any conflict.
                    </span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input type="radio" checked={strategy === 'patch'} onChange={() => setStrategy('patch')} />
                    <span>
                      <b>Patch-based</b> — apply the PR&apos;s whole diff as one reviewed commit (for merge commits, rebased/force-pushed or squashed PRs).
                    </span>
                  </label>
                  <div className="flex items-center gap-3 pt-1">
                    <Button variant="primary" onClick={start} disabled={!canStart}>
                      Create <code>{plan.branchName}</code> from org {config.org.branch} &amp; apply
                    </Button>
                    {!writable && <span className="text-xs text-amber-300">Preview-only mode is on (Setup → Review).</span>}
                    {strategy === 'cherry-pick' && selectedCount === 0 && <span className="text-xs text-slate-500">Select at least one commit.</span>}
                  </div>
                  <p className="text-xs text-slate-500">This only changes your local org clone. Nothing is pushed until you confirm in the last step.</p>
                </div>
              </Card>
            </>
          )}

          {inConflict && outcome?.status === 'conflict' && (
            <Card title="Stopped on conflicts" actions={<Badge tone="bad">needs you</Badge>}>
              <div className="space-y-2 text-sm">
                <Alert tone="bad" title="Nothing was skipped or discarded">
                  <ul className="list-disc pl-4">
                    {outcome.recovery?.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </Alert>
                <p className="font-mono text-xs text-rose-300">{outcome.conflictFiles?.join(', ')}</p>
                <div className="flex gap-3">
                  <Button variant="primary" onClick={() => resume('continue')} disabled={!!busy}>
                    I resolved &amp; staged them — Continue
                  </Button>
                  <Button variant="danger" onClick={() => setConfirmAbort(true)} disabled={!!busy}>
                    Abort and restore
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {outcome && outcome.record.commits.length > 0 && (
            <Card title="Transfer progress">
              <ul className="space-y-1 text-sm">
                {outcome.record.commits.map((c) => (
                  <li key={c.sha} className="flex items-center gap-2">
                    <Badge tone={c.result === 'applied' ? 'good' : c.result === 'conflict' ? 'bad' : c.result === 'skipped-empty' ? 'warn' : 'neutral'}>{c.result}</Badge>
                    <Sha sha={c.sha} /> {c.subject}
                    {c.result === 'skipped-empty' && <span className="text-xs text-amber-300">change already present, recorded explicitly</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {review && plan && (
        <>
          <Card title="4 · Review the transfer branch" actions={<Badge tone="info">{review.record.status}</Badge>}>
            <p className="mb-2 text-sm">
              Branch <code>{review.record.branch}</code> (tip <Sha sha={review.record.tip} />) on top of org <code>{review.record.targetBranch}</code> <Sha sha={review.record.baseSha} />
            </p>
            <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Commits to be pushed</h4>
            <CommitList commits={review.commits} />
            <h4 className="mb-1 mt-4 text-xs font-semibold uppercase text-slate-500">Files</h4>
            <FileList files={review.files} />
            <pre className="mt-3 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-400">{review.stat}</pre>
          </Card>
          <Card title="Final diff against org">
            <DiffView text={review.diff.text} truncated={review.diff.truncated} />
          </Card>
          {!published && (
            <Card title="5 · Publish">
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={() => setConfirmPublish(true)} disabled={!writable || !!busy}>
                  Push branch &amp; create org PR…
                </Button>
                <Button variant="danger" onClick={() => setConfirmAbort(true)} disabled={!!busy || review.record.status !== 'ready-for-review'}>
                  Discard transfer branch
                </Button>
                {!writable && <span className="text-xs text-amber-300">Preview-only mode is on.</span>}
              </div>
              <p className="mt-2 text-xs text-slate-500">A human must review and merge the org PR. This tool never merges and never pushes to {config.org.branch}.</p>
            </Card>
          )}
        </>
      )}

      {published && (
        <Alert tone={published.prCreated || published.orgPrUrl ? 'good' : 'warn'} title={published.orgPrUrl ? 'Org PR ready for human review' : 'Branch pushed'}>
          <p>
            Branch pushed at <Sha sha={published.pushedSha} />.
          </p>
          {published.orgPrUrl && <p className="break-all font-mono text-xs">{published.orgPrUrl}</p>}
          {published.note && <p>{published.note}</p>}
          {published.manualPrUrl && <p className="break-all font-mono text-xs">Open manually: {published.manualPrUrl}</p>}
        </Alert>
      )}

      <ConfirmDialog
        open={confirmPublish}
        title="Push the transfer branch to the org remote?"
        confirmLabel="Push & create PR"
        busy={!!busy}
        onConfirm={publish}
        onCancel={() => setConfirmPublish(false)}
      >
        <p>
          This writes to the <b>org remote</b>: it pushes new branch <code>{review?.record.branch}</code> (never <code>{config.org.branch}</code>, never forced) and, if an API token is configured, opens a PR into <code>{config.org.branch}</code> that links the original intern PR.
        </p>
        <p>The remote is re-checked first. The PR will not be merged automatically.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmAbort}
        title="Abort this transfer?"
        confirmLabel="Abort & restore"
        danger
        busy={!!busy}
        onConfirm={() => resume('abort')}
        onCancel={() => setConfirmAbort(false)}
      >
        <p>
          The local transfer branch is deleted and your original branch is restored. Any conflict resolutions you made on it are lost. Nothing on the remote changes.
        </p>
      </ConfirmDialog>
    </div>
  );
}
