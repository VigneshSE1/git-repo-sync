import { tokenFor, type Role } from '../config';
import { AppError } from '../errors';
import type { GitRepo } from '../git/repo';
import type { ProviderKind } from '../validation';
import { GitHubProvider } from './github';
import { LocalDemoProvider } from './local';
import type { GitProvider } from './types';

export interface ProviderContext {
  role: Role;
  kind: ProviderKind;
  /** Needed only by the local demo provider. */
  repo?: GitRepo;
  remote?: string;
  branch?: string;
}

/**
 * Registry. To add Azure DevOps: implement GitProvider (list PRs, commits, files, create PR)
 * and return it for the 'azure-devops' kind below.
 */
export function createProvider(ctx: ProviderContext): GitProvider {
  switch (ctx.kind) {
    case 'github':
      return new GitHubProvider(tokenFor(ctx.role));
    case 'local':
      if (!ctx.repo || !ctx.remote || !ctx.branch) throw new AppError('PRECONDITION', 'Local provider needs a repository context.');
      return new LocalDemoProvider(ctx.repo, ctx.remote, ctx.branch);
    case 'azure-devops':
    case 'other':
      throw new AppError('UNSUPPORTED', `The "${ctx.kind}" provider has no PR API integration yet.`, {
        hint: 'Git-based workflows (Sync) still work. Use the GitHub provider, or implement the GitProvider interface for this host.',
      });
  }
}

export * from './types';
