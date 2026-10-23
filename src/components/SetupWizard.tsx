'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { AppConfig, ConfigResponse, ValidateResult } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { Alert, Badge, Button, Card, ErrorBox, Sha, Spinner, Stepper } from './ui';

type Provider = AppConfig['org']['provider'];
type RepoDraft = { url: string; path: string; provider: Provider; branch: string };
type Draft = { org: RepoDraft; intern: RepoDraft; preferences: AppConfig['preferences'] };

const EMPTY: Draft = {
  org: { url: '', path: '', provider: 'github', branch: 'develop' },
  intern: { url: '', path: '', provider: 'github', branch: 'develop' },
  preferences: { syncStrategy: 'merge', transferViaPr: true, prDiscovery: 'api', previewOnly: true },
};

const STEPS = ['Repositories', 'Preferences', 'Authentication', 'Validate', 'Review & save'];

function RepoForm({ title, role, value, onChange }: { title: string; role: string; value: RepoDraft; onChange: (v: RepoDraft) => void }) {
  const set = (patch: Partial<RepoDraft>) => onChange({ ...value, ...patch });
  return (
    <Card title={title}>
      <div className="space-y-3">
        <label className="block text-xs text-slate-400">
          Repository URL (HTTPS, SSH or local path)
          <input type="text" value={value.url} onChange={(e) => set({ url: e.target.value })} placeholder={`https://github.com/<${role}-owner>/<repo>.git`} />
        </label>
        <label className="block text-xs text-slate-400">
          Local clone path (absolute)
          <input type="text" value={value.path} onChange={(e) => set({ path: e.target.value })} placeholder="C:\\work\\repo-clone" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-slate-400">
            {role === 'org' ? 'Source branch' : 'Target branch'}
            <input type="text" value={value.branch} onChange={(e) => set({ branch: e.target.value })} />
          </label>
          <label className="block text-xs text-slate-400">
            Git hosting provider
            <select value={value.provider} onChange={(e) => set({ provider: e.target.value as Provider })}>
              <option value="github">GitHub</option>
              <option value="azure-devops">Azure DevOps (git only, no PR API yet)</option>
              <option value="other">Other (git only)</option>
              <option value="local">Local demo</option>
            </select>
          </label>
        </div>
      </div>
    </Card>
  );
}

export function SetupWizard({ saved, onSaved }: { saved: ConfigResponse | null; onSaved: () => void }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(() => (saved?.config ? { ...saved.config } : EMPTY));
  const [validation, setValidation] = useState<Record<'org' | 'intern', ValidateResult> | null>(null);
  const [auth, setAuth] = useState<Record<string, { git: { ok: boolean; sha?: string | null; error?: { message: string; hint?: string } }; token: { tokenConfigured: boolean; source: string | null } }>>({});
  const { busy, error, run } = useAsync();
  const authLive = saved?.auth;

  const setPref = (patch: Partial<Draft['preferences']>) => setDraft((d) => ({ ...d, preferences: { ...d.preferences, ...patch } }));

  const checkAuth = (role: 'org' | 'intern') =>
    run(`Checking ${role} Git access`, async () => {
      const r = await api<(typeof auth)[string]>('POST', 'setup/auth-check', { role, url: draft[role].url, branch: draft[role].branch });
      setAuth((a) => ({ ...a, [role]: r }));
    });

  const validate = () =>
    run('Validating repositories', async () => {
      setValidation(await api('POST', 'setup/validate', draft));
    });

  const clone = (role: 'org' | 'intern') =>
    run(`Cloning ${role}`, async () => {
      await api('POST', 'setup/clone', { url: draft[role].url, path: draft[role].path, branch: draft[role].branch, confirm: true });
      setValidation(await api('POST', 'setup/validate', draft));
    });

  const save = () =>
    run('Saving configuration', async () => {
      await api('PUT', 'config', draft);
      onSaved();
    });

  const demo = () =>
    run('Creating demo repositories', async () => {
      await api('POST', 'setup/demo', {});
      onSaved();
    });

  const allOk = validation && validation.org.ok && validation.intern.ok;

  return (
    <div className="space-y-4">
      <Stepper steps={STEPS} current={step} />
      <ErrorBox error={error} />

      {step === 0 && (
        <>
          <Alert tone="info" title="No repositories yet?">
            <p>
              Try everything safely against temporary local repositories (a fake org, a fake intern, and intern &quot;PRs&quot; as branches).{' '}
              <Button variant="primary" className="ml-2" onClick={demo} disabled={!!busy}>
                Use demo repositories
              </Button>
            </p>
          </Alert>
          <div className="grid gap-4 lg:grid-cols-2">
            <RepoForm title="Organization repository (source of truth)" role="org" value={draft.org} onChange={(org) => setDraft({ ...draft, org })} />
            <RepoForm title="Intern repository" role="intern" value={draft.intern} onChange={(intern) => setDraft({ ...draft, intern })} />
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => setStep(1)}
              disabled={!draft.org.url || !draft.org.path || !draft.intern.url || !draft.intern.path}
            >
              Next
            </Button>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <Card title="Workflow preferences">
            <div className="space-y-4 text-sm">
              <fieldset className="space-y-1">
                <legend className="mb-1 text-slate-300">Sync Org → Intern: default strategy</legend>
                <label className="flex items-start gap-2">
                  <input type="radio" checked={draft.preferences.syncStrategy === 'merge'} onChange={() => setPref({ syncStrategy: 'merge' })} />
                  <span>
                    <b>Safe merge</b> — merge org develop into intern develop, preserving intern-only commits.
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" checked={draft.preferences.syncStrategy === 'exact'} onChange={() => setPref({ syncStrategy: 'exact' })} />
                  <span>
                    <b>Exact copy</b> — make intern develop identical to org develop. Discards intern-only commits (backed up first, force-with-lease push only after confirmation).
                  </span>
                </label>
              </fieldset>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={draft.preferences.transferViaPr} onChange={(e) => setPref({ transferViaPr: e.target.checked })} />
                <span>
                  Transfer intern PRs to a <b>new org branch and open a PR</b> (recommended). Transfers never push to develop. If unchecked, only the branch is pushed.
                </span>
              </label>
              <fieldset className="space-y-1">
                <legend className="mb-1 text-slate-300">Finding intern PRs</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={draft.preferences.prDiscovery === 'api'} onChange={() => setPref({ prDiscovery: 'api' })} />
                  Discover automatically through the provider API
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={draft.preferences.prDiscovery === 'manual'} onChange={() => setPref({ prDiscovery: 'manual' })} />
                  Enter a PR URL / number manually
                </label>
              </fieldset>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={draft.preferences.previewOnly} onChange={(e) => setPref({ previewOnly: e.target.checked })} />
                <span>
                  <b>Preview-only mode</b> (default): fetch, compare and preview; all write operations stay disabled.
                </span>
              </label>
            </div>
          </Card>
          <Nav onBack={() => setStep(0)} onNext={() => setStep(2)} />
        </>
      )}

      {step === 2 && (
        <>
          <Card title="Git access (uses your existing credential manager or SSH keys)">
            <div className="space-y-3 text-sm">
              {(['org', 'intern'] as const).map((role) => (
                <div key={role} className="flex flex-wrap items-center gap-3">
                  <span className="w-16 text-slate-400">{role}</span>
                  <Button onClick={() => checkAuth(role)} disabled={!!busy}>
                    Test Git access
                  </Button>
                  {auth[role] &&
                    (auth[role].git.ok ? (
                      <Badge tone="good">reachable{auth[role].git.sha ? ` · tip ${auth[role].git.sha!.slice(0, 8)}` : ' · branch not found'}</Badge>
                    ) : (
                      <span className="text-rose-300">
                        {auth[role].git.error?.message} {auth[role].git.error?.hint}
                      </span>
                    ))}
                </div>
              ))}
              <p className="text-xs text-slate-500">
                Git never prompts here (prompts are disabled). If a test fails, run <code>git ls-remote &lt;url&gt;</code> in a terminal once to sign in, then retest.
              </p>
            </div>
          </Card>
          <Card title="GitHub API token (for listing PRs and creating the org PR)">
            <div className="space-y-2 text-sm">
              {(['org', 'intern'] as const).map((role) => (
                <div key={role} className="flex items-center gap-3">
                  <span className="w-16 text-slate-400">{role}</span>
                  {authLive?.[role].tokenConfigured ? <Badge tone="good">configured via {authLive[role].source}</Badge> : <Badge tone="warn">not configured</Badge>}
                </div>
              ))}
              <Alert tone="info" title="How to configure (never paste tokens here or in chat)">
                <p>
                  Create <code>.env.local</code> next to <code>package.json</code> (see <code>.env.example</code>), then restart the dev server:
                </p>
                <pre className="mt-1 overflow-auto rounded bg-slate-950 p-2 text-xs">{`GITHUB_TOKEN_INTERN=...   # fine-grained PAT: Pull requests (read), Contents (read)
GITHUB_TOKEN_ORG=...      # fine-grained PAT: Pull requests (read & write), Contents (read & write)`}</pre>
                <p>Without a token you can still sync with local Git; PR listing/creation is unavailable and nothing is faked.</p>
              </Alert>
            </div>
          </Card>
          <Nav onBack={() => setStep(1)} onNext={() => setStep(3)} />
        </>
      )}

      {step === 3 && (
        <>
          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={validate} disabled={!!busy}>
              Verify remotes, fetch and show latest develop
            </Button>
            {busy && <Spinner label={busy} />}
          </div>
          {validation && (
            <div className="grid gap-4 lg:grid-cols-2">
              {(['org', 'intern'] as const).map((role) => (
                <Card key={role} title={`${role} repository`} actions={<Badge tone={validation[role].ok ? 'good' : 'bad'}>{validation[role].ok ? 'ok' : 'needs attention'}</Badge>}>
                  <ul className="space-y-1.5 text-sm">
                    {validation[role].checks.map((c) => (
                      <li key={c.name} className="flex gap-2">
                        <span className={c.ok ? 'text-emerald-400' : 'text-rose-400'}>{c.ok ? '✓' : '✗'}</span>
                        <span>
                          <span className="text-slate-200">{c.name}</span>
                          <span className="block break-all text-xs text-slate-500">{c.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {validation[role].latest && (
                    <p className="mt-3 text-sm">
                      Latest {draft[role].branch}: <Sha sha={validation[role].latest!.sha} /> {validation[role].latest!.subject}
                    </p>
                  )}
                  {!validation[role].ok && (
                    <div className="mt-3">
                      <Button onClick={() => clone(role)} disabled={!!busy}>
                        Clone into {draft[role].path}
                      </Button>
                      <p className="mt-1 text-xs text-slate-500">Only works if the folder does not exist or is empty.</p>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
          <Nav onBack={() => setStep(2)} onNext={() => setStep(4)} nextDisabled={!allOk} nextHint={!allOk ? 'Both repositories must validate.' : undefined} />
        </>
      )}

      {step === 4 && (
        <>
          <Card title="Review before enabling anything">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-800">
                <Line k="Organization (source)" v={`${draft.org.url} @ ${draft.org.branch} (${draft.org.provider})`} />
                <Line k="Org clone" v={draft.org.path} />
                <Line k="Intern (target)" v={`${draft.intern.url} @ ${draft.intern.branch} (${draft.intern.provider})`} />
                <Line k="Intern clone" v={draft.intern.path} />
                <Line k="Sync strategy" v={draft.preferences.syncStrategy === 'merge' ? 'Safe merge (keeps intern-only commits)' : 'Exact copy (discards intern-only commits after confirmation)'} />
                <Line k="PR transfer" v={draft.preferences.transferViaPr ? 'New org branch + PR (never merged automatically)' : 'New org branch only'} />
                <Line k="PR discovery" v={draft.preferences.prDiscovery === 'api' ? 'Provider API' : 'Manual PR entry'} />
                <Line
                  k="API tokens"
                  v={(['org', 'intern'] as const).map((r) => `${r}: ${authLive?.[r].tokenConfigured ? 'configured' : 'missing'}`).join(' · ')}
                />
                <Line k="Planned remote writes" v="Push intern develop (after confirmation) · push sync/intern-pr-N to org (after confirmation) · create org PR" />
              </tbody>
            </table>
            <label className="mt-4 flex items-start gap-2 text-sm">
              <input type="checkbox" checked={draft.preferences.previewOnly} onChange={(e) => setPref({ previewOnly: e.target.checked })} />
              <span>
                <b>Preview-only mode</b>. Uncheck to enable local apply and remote writes (each still needs its own confirmation).
              </span>
            </label>
          </Card>
          <Nav onBack={() => setStep(3)} onNext={save} nextLabel="Save configuration" nextDisabled={!!busy} />
        </>
      )}
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="w-48 py-1.5 pr-3 align-top text-slate-500">{k}</td>
      <td className="break-all py-1.5">{v}</td>
    </tr>
  );
}

function Nav({
  onBack,
  onNext,
  nextLabel = 'Next',
  nextDisabled,
  nextHint,
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextHint?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <Button variant="ghost" onClick={onBack}>
        Back
      </Button>
      <div className="flex items-center gap-3">
        {nextHint && <span className="text-xs text-slate-500">{nextHint}</span>}
        <Button variant="primary" onClick={onNext} disabled={nextDisabled}>
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}
