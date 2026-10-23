'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ConfigResponse, DashboardStatus, Tab } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { Dashboard } from './Dashboard';
import { OperationLog } from './OperationLog';
import { SetupWizard } from './SetupWizard';
import { SyncWorkflow } from './SyncWorkflow';
import { TransferWorkflow } from './TransferWorkflow';
import { Alert, cx } from './ui';

const TABS: Array<[Tab, string]> = [
  ['dashboard', 'Dashboard'],
  ['sync', 'Sync Org → Intern'],
  ['transfer', 'Transfer Intern PR → Org'],
  ['setup', 'Setup'],
  ['log', 'Operation log'],
];

export function Shell() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [conf, setConf] = useState<ConfigResponse | null>(null);
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const { busy, error, run } = useAsync();

  const loadConfig = useCallback(async () => {
    const c = await api<ConfigResponse>('GET', 'config');
    setConf(c);
    return c;
  }, []);

  const refreshStatus = useCallback(
    async (fetch: boolean) => {
      const s = await run(fetch ? 'Fetching remotes' : 'Reading status', () => api<DashboardStatus>('POST', 'status', { fetch }));
      if (s) setStatus(s);
    },
    [run],
  );

  useEffect(() => {
    void (async () => {
      try {
        const c = await loadConfig();
        if (!c.configured) setTab('setup');
        else void refreshStatus(false);
      } catch {
        /* surfaced by the Dashboard on retry */
      }
    })();
  }, [loadConfig, refreshStatus]);

  const configured = !!conf?.configured;
  const previewOnly = conf?.config?.preferences.previewOnly ?? true;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-50">Git Repo Sync</h1>
          <p className="text-xs text-slate-500">Org → Intern sync and reviewed PR transfer · runs locally · Git runs on the server only</p>
        </div>
        {configured && (
          <button
            onClick={() => setTab('setup')}
            className={cx('rounded-full px-3 py-1 text-xs font-medium', previewOnly ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300')}
          >
            {previewOnly ? 'Preview-only mode: writes disabled' : 'Write operations enabled'}
          </button>
        )}
      </header>

      <nav className="mb-5 flex flex-wrap gap-1 border-b border-slate-800">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            disabled={!configured && id !== 'setup' && id !== 'log'}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm transition disabled:opacity-30',
              tab === id ? 'border-sky-500 text-slate-50' : 'border-transparent text-slate-400 hover:text-slate-200',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      {!configured && tab !== 'setup' && tab !== 'log' && <Alert tone="warn" title="Not configured">Complete the setup wizard first.</Alert>}

      {tab === 'dashboard' && configured && (
        <Dashboard status={status} busy={busy} error={error} onRefresh={refreshStatus} onNavigate={setTab} previewOnly={previewOnly} />
      )}
      {tab === 'sync' && configured && conf?.config && <SyncWorkflow config={conf.config} onDone={() => refreshStatus(false)} />}
      {tab === 'transfer' && configured && conf?.config && <TransferWorkflow config={conf.config} onDone={() => refreshStatus(false)} />}
      {tab === 'setup' && (
        <SetupWizard
          saved={conf}
          onSaved={async () => {
            await loadConfig();
            await refreshStatus(true);
            setTab('dashboard');
          }}
        />
      )}
      {tab === 'log' && <OperationLog />}
    </div>
  );
}
