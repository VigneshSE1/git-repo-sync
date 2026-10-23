import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { authStatus, loadConfig, requireConfig, saveConfig } from './config';
import { syncContext, transferContext } from './context';
import { createDemo } from './demo';
import { AppError } from './errors';
import { GitRepo, validateRepo } from './git/repo';
import { clearLog, getLog } from './log';
import { redact } from './redact';
import { listTransfers } from './state';
import { checkGitAuth, dashboardStatus, fetchBoth } from './status';
import {
  appConfigSchema,
  branchName,
  prStateFilter,
  remoteUrl,
  syncApplyRequest,
  syncPreviewRequest,
  syncPushRequest,
  transferPlanRequest,
  transferPublishRequest,
  transferResumeRequest,
  transferStartRequest,
} from './validation';
import { applySync, previewSync, pushSync, rollbackSync } from './workflows/sync';
import {
  listPullRequestsWithStatus,
  planTransfer,
  publishTransfer,
  resumeTransfer,
  reviewTransfer,
  startTransfer,
} from './workflows/transfer';

type Handler = (input: { body: unknown; query: URLSearchParams }) => Promise<unknown>;

const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => schema.parse(data ?? {});

const roleSchema = z.object({ role: z.enum(['org', 'intern']) });

/** Every route the UI can call. All Git/provider work happens here, on the server. */
const routes: Record<string, Handler> = {
  'GET config': async () => {
    const config = loadConfig();
    return { configured: !!config, config, auth: authStatus() };
  },

  'PUT config': async ({ body }) => {
    const config = parse(appConfigSchema, body);
    saveConfig(config);
    return { config };
  },

  'POST setup/auth-check': async ({ body }) => {
    const { role, url, branch } = parse(roleSchema.extend({ url: remoteUrl, branch: branchName.default('develop') }), body);
    return { git: await checkGitAuth(url, branch), token: authStatus()[role] };
  },

  'POST setup/validate': async ({ body }) => {
    const draft = body && Object.keys(body as object).length ? parse(appConfigSchema, body) : requireConfig();
    const out: Record<string, unknown> = {};
    for (const role of ['org', 'intern'] as const) {
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
      const cfg = draft[role];
      let latest = null;
      try {
        const v = await validateRepo(cfg, role, {});
        checks.push({ name: 'Local clone and remote identity', ok: true, detail: `${cfg.path} (remote "${v.remote}", on ${v.currentBranch})` });
        await v.repo.fetchRemote(v.remote);
        checks.push({ name: 'Fetch remote references', ok: true, detail: 'fetched' });
        latest = await v.repo.commitInfo(`refs/remotes/${v.remote}/${cfg.branch}`);
        checks.push({
          name: `Branch ${cfg.branch} on remote`,
          ok: !!latest,
          detail: latest ? `${latest.sha.slice(0, 8)} ${latest.subject}` : 'not found - check the branch name',
        });
        const st = await v.repo.status();
        checks.push({ name: 'Working tree clean', ok: st.clean, detail: st.clean ? 'clean' : `${st.tracked.length} uncommitted file(s); writes will be refused` });
        const id = await v.repo.identity();
        checks.push({ name: 'Git identity (user.name / user.email)', ok: !!(id.name && id.email), detail: id.name && id.email ? `${id.name} <${id.email}>` : 'not set; commits and merges will fail' });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError('GIT', String(e));
        checks.push({ name: 'Repository', ok: false, detail: `${redact(err.message)}${err.hint ? ` - ${err.hint}` : ''}` });
      }
      out[role] = { ok: checks.every((c) => c.ok), checks, latest };
    }
    return out;
  },

  'POST setup/clone': async ({ body }) => {
    const req = parse(
      z.object({ url: remoteUrl, path: z.string().refine((p) => path.isAbsolute(p), 'Absolute path required'), branch: branchName.default('develop'), confirm: z.literal(true) }),
      body,
    );
    if (fs.existsSync(req.path) && fs.readdirSync(req.path).length > 0) {
      throw new AppError('PRECONDITION', 'The target folder already exists and is not empty; refusing to clone into it.');
    }
    fs.mkdirSync(path.dirname(req.path), { recursive: true });
    await new GitRepo(path.dirname(req.path), 'clone').run(['clone', '--', req.url, req.path], { timeoutMs: 600_000 });
    return { cloned: req.path };
  },

  'POST setup/demo': async () => {
    const { root, config } = await createDemo();
    return { root, config };
  },

  'POST status': async ({ body }) => {
    const { fetch } = parse(z.object({ fetch: z.boolean().default(false) }), body);
    return dashboardStatus(requireConfig(), { fetch });
  },

  'POST sync/fetch': async () => {
    await fetchBoth(requireConfig());
    return { fetched: true };
  },
  'POST sync/preview': async ({ body }) => previewSync(syncContext(), parse(syncPreviewRequest, body)),
  'POST sync/apply': async ({ body }) => applySync(syncContext(), parse(syncApplyRequest, body)),
  'POST sync/push': async ({ body }) => pushSync(syncContext(), parse(syncPushRequest, body)),
  'POST sync/rollback': async ({ body }) => {
    parse(z.object({ confirm: z.literal(true) }), body);
    return rollbackSync(syncContext(), { confirm: true });
  },

  'GET transfer/prs': async ({ query }) => {
    const state = prStateFilter.parse(query.get('state') ?? 'open');
    return { prs: await listPullRequestsWithStatus(await transferContext(), state) };
  },
  'POST transfer/plan': async ({ body }) => planTransfer(await transferContext(), parse(transferPlanRequest, body)),
  'POST transfer/start': async ({ body }) => startTransfer(await transferContext(), parse(transferStartRequest, body)),
  'POST transfer/resume': async ({ body }) => resumeTransfer(await transferContext(), parse(transferResumeRequest, body)),
  'POST transfer/review': async ({ body }) => reviewTransfer(await transferContext(), parse(transferPlanRequest, body)),
  'POST transfer/publish': async ({ body }) => publishTransfer(await transferContext(), parse(transferPublishRequest, body)),
  'GET transfer/records': async () => ({ records: listTransfers() }),

  'GET log': async ({ query }) => ({ entries: getLog(Math.min(Number(query.get('limit')) || 200, 1000)) }),
  'POST log/clear': async () => {
    clearLog();
    return { cleared: true };
  },
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Local-only tool that can write to Git repos: refuse cross-site / DNS-rebinding requests. */
function assertLocalRequest(req: Request): void {
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) throw new AppError('AUTH', 'This tool only answers requests addressed to localhost.');
  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== req.headers.get('host')) {
      throw new AppError('AUTH', 'Cross-origin requests are not allowed.');
    }
    if (req.headers.get('x-grs') !== '1') throw new AppError('AUTH', 'Missing X-GRS header.');
  }
}

function errorResponse(e: unknown) {
  if (e instanceof ZodError) {
    const message = e.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ');
    return NextResponse.json({ ok: false, error: { code: 'VALIDATION', message, details: { issues: e.issues } } }, { status: 400 });
  }
  if (e instanceof AppError) {
    return NextResponse.json(
      { ok: false, error: { code: e.code, message: redact(e.message), hint: e.hint ? redact(e.hint) : undefined, details: e.details } },
      { status: e.status },
    );
  }
  const message = redact(e instanceof Error ? e.message : String(e));
  return NextResponse.json({ ok: false, error: { code: 'INTERNAL', message } }, { status: 500 });
}

export async function dispatch(req: Request, segments: string[]): Promise<Response> {
  try {
    assertLocalRequest(req);
    const key = `${req.method} ${segments.join('/')}`;
    const handler = routes[key];
    if (!handler) throw new AppError('NOT_FOUND', `Unknown endpoint: ${key}`);
    let body: unknown = undefined;
    if (req.method !== 'GET') {
      const text = await req.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new AppError('VALIDATION', 'Request body must be JSON.');
        }
      }
    }
    const data = await handler({ body, query: new URL(req.url).searchParams });
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return errorResponse(e);
  }
}
