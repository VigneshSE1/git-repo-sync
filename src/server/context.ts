import { requireConfig } from './config';
import { AppError } from './errors';
import { validateRepo } from './git/repo';
import { createProvider } from './providers';
import type { GitProvider } from './providers/types';
import type { AppConfig } from './validation';
import type { SyncContext } from './workflows/sync';
import type { TransferContext } from './workflows/transfer';

export function syncContext(cfg: AppConfig = requireConfig()): SyncContext {
  return {
    org: { path: cfg.org.path, url: cfg.org.url, branch: cfg.org.branch },
    intern: { path: cfg.intern.path, url: cfg.intern.url, branch: cfg.intern.branch },
    previewOnly: cfg.preferences.previewOnly,
  };
}

export async function transferContext(cfg: AppConfig = requireConfig()): Promise<TransferContext> {
  const base = syncContext(cfg);
  const intern = await validateRepo(base.intern, 'intern', {});
  const internProvider = createProvider({
    role: 'intern',
    kind: cfg.intern.provider,
    repo: intern.repo,
    remote: intern.remote,
    branch: cfg.intern.branch,
  });
  let orgProvider: GitProvider | null = null;
  // When the user opted out of PR creation, the branch is pushed and the PR is left to a human.
  if (cfg.preferences.transferViaPr) {
    try {
      orgProvider = createProvider({ role: 'org', kind: cfg.org.provider });
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'UNSUPPORTED')) throw e;
    }
  }
  return { ...base, internProvider, orgProvider };
}
