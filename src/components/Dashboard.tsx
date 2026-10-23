'use client';
import type { ApiError } from '@/lib/api';
import type { DashboardStatus, Tab } from '@/lib/types';
import { Alert, Badge, Button, Card, ErrorBox, Sha, Spinner } from './ui';

type RepoStatus = DashboardStatus['org'];

function RepoCard({ repo, title }: { repo: RepoStatus; title: string }) {
  return (
    <Card title={title} actions={<Badge tone={repo.valid ? 'good' : 'bad'}>{repo.valid ? 'valid' : 'problem'}</Badge>}>
      <dl className="space-y-1.5 text-sm">
        <Row k="Remote" v={<span className="break-all font-mono text-xs">{repo.url}</span>} />
        <Row k="Clone" v={<span className="break-all font-mono text-xs">{repo.path}</span>} />
        <Row k="Provider" v={repo.provider} />
        <Row
          k={`Latest ${repo.branch}`}
          v={
            repo.latest ? (
              <span>
                <Sha sha={repo.latest.sha} /> <span className="ml-1">{repo.latest.subject}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {repo.latest.author} · {new Date(repo.latest.date).toLocaleString()}
                </span>
              </span>
            ) : (
              <span className="text-slate-500">not fetched yet</span>
            )
          }
        />
        {repo.valid && (
          <>
            <Row k="Checked out" v={repo.currentBranch} />
            <Row
              k="Working tree"
              v={
                repo.clean ? (
                  <Badge tone="good">clean{repo.untracked ? ` (${repo.untracked} untracked)` : ''}</Badge>
                ) : (
                  <Badge tone="warn">{repo.trackedChanges} uncommitted file(s)</Badge>
                )
              }
            />
            {repo.localVsRemote && (
              <Row k={`Local ${repo.branch} vs remote`} v={`${repo.localVsRemote.ahead} ahead / ${repo.localVsRemote.behind} behind`} />
            )}
          </>
        )}
      </dl>
      {repo.error && (
        <div className="mt-3">
          <Alert tone="bad" title={repo.error.message}>
            {repo.error.hint && <p>{repo.error.hint}</p>}
          </Alert>
        </div>
      )}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-36 shrink-0 text-slate-500">{k}</dt>
      <dd className="min-w-0 flex-1">{v}</dd>
    </div>
  );
}

export function Dashboard({
  status,
  busy,
  error,
  onRefresh,
  onNavigate,
  previewOnly,
}: {
  status: DashboardStatus | null;
  busy: string | null;
  error: ApiError | null;
  onRefresh: (fetch: boolean) => void;
  onNavigate: (t: Tab) => void;
  previewOnly: boolean;
}) {
  const cmp = status?.comparison;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          onClick={() => onNavigate('sync')}
          className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-4 text-left transition hover:bg-sky-500/20"
        >
          <div className="text-base font-semibold text-sky-200">Sync Org → Intern</div>
          <p className="mt-1 text-sm text-slate-400">Bring the latest org develop into the intern repo before development starts.</p>
        </button>
        <button
          onClick={() => onNavigate('transfer')}
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-left transition hover:bg-emerald-500/20"
        >
          <div className="text-base font-semibold text-emerald-200">Transfer Intern PR → Org</div>
          <p className="mt-1 text-sm text-slate-400">Move a reviewed intern PR into the org repo as a new branch and PR. Never merges.</p>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => onRefresh(true)} disabled={!!busy}>
          Fetch both remotes
        </Button>
        <Button variant="ghost" onClick={() => onRefresh(false)} disabled={!!busy}>
          Re-read local state
        </Button>
        {busy && <Spinner label={busy} />}
        {status?.fetchedAt && <span className="text-xs text-slate-500">fetched {new Date(status.fetchedAt).toLocaleTimeString()}</span>}
      </div>

      <ErrorBox error={error} />
      {status?.fetchError && (
        <Alert tone="bad" title={`Fetch failed: ${status.fetchError.message}`}>
          {status.fetchError.hint && <p>{status.fetchError.hint}</p>}
        </Alert>
      )}
      {previewOnly && (
        <Alert tone="warn" title="Preview-only mode">
          You can fetch, compare and preview. Applying, pushing and transferring are disabled until you turn this off in Setup → Review.
        </Alert>
      )}

      {status && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <RepoCard repo={status.org} title="Organization repository (source of truth)" />
            <RepoCard repo={status.intern} title="Intern repository" />
          </div>

          <Card title="Org develop vs Intern develop">
            {cmp ? (
              cmp.unrelated ? (
                <Alert tone="warn" title="Unrelated histories">
                  The repositories have no common commit. A merge needs the explicit unrelated-histories option; exact sync is also possible.
                </Alert>
              ) : (
                <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
                  <div>
                    <span className="text-2xl font-semibold text-amber-300">{cmp.behindOrg}</span>{' '}
                    <span className="text-slate-400">org commit(s) missing from intern (behind)</span>
                  </div>
                  <div>
                    <span className="text-2xl font-semibold text-sky-300">{cmp.aheadOfOrg}</span>{' '}
                    <span className="text-slate-400">intern-only commit(s) (ahead)</span>
                  </div>
                  <div className="text-slate-500">
                    Last sync: {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'never'}
                  </div>
                </div>
              )
            ) : (
              <p className="text-sm text-slate-500">Fetch both remotes to compare.</p>
            )}
            {status.sync?.phase === 'applied' && (
              <div className="mt-3">
                <Alert tone="warn" title="A sync was applied locally but not pushed">
                  Open Sync to push or roll back. Backup branch: <code>{status.sync.backupBranch}</code>
                </Alert>
              </div>
            )}
          </Card>

          <Card title="Transfers">
            {status.transfers.length === 0 ? (
              <p className="text-sm text-slate-500">No transfers yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="py-1">PR</th>
                    <th>Branch</th>
                    <th>Status</th>
                    <th>Org PR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {status.transfers.map((t) => (
                    <tr key={t.prNumber + t.branch}>
                      <td className="py-1.5">
                        #{t.prNumber} {t.title}
                      </td>
                      <td className="font-mono text-xs">{t.branch}</td>
                      <td>
                        <Badge tone={t.status === 'pr-created' ? 'good' : t.status === 'conflict' ? 'bad' : t.status === 'aborted' ? 'neutral' : 'info'}>{t.status}</Badge>
                      </td>
                      <td className="text-xs">{t.orgPrUrl ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Authentication">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              {(['org', 'intern'] as const).map((r) => (
                <div key={r} className="flex items-center gap-2">
                  <span className="w-16 text-slate-500">{r}</span>
                  {status.auth[r].tokenConfigured ? (
                    <Badge tone="good">API token via {status.auth[r].source}</Badge>
                  ) : (
                    <Badge tone="warn">no API token (PR listing/creation unavailable)</Badge>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
