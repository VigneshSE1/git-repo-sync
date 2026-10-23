import path from 'node:path';
import { z } from 'zod';
import { hasEmbeddedCredentials, isAllowedRemote } from './remote';

export const branchName = z
  .string()
  .trim()
  .min(1, 'Branch name is required')
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Branch contains invalid characters')
  .refine((b) => !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.') && !b.endsWith('.lock'), {
    message: 'Invalid branch name',
  });

export const commitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/i, 'Expected a full commit SHA');

export const remoteUrl = z
  .string()
  .trim()
  .min(1, 'Repository URL is required')
  .max(500)
  .refine(isAllowedRemote, 'Unsupported or unsafe repository URL (use https://, ssh://, git@host:path or a local path)')
  .refine((u) => !hasEmbeddedCredentials(u), 'Do not embed credentials in the URL; use your Git credential manager or SSH keys');

export const providerKind = z.enum(['github', 'azure-devops', 'other', 'local']);
export type ProviderKind = z.infer<typeof providerKind>;

export const repoConfigSchema = z.object({
  url: remoteUrl,
  path: z
    .string()
    .trim()
    .min(1, 'Local path is required')
    .refine((p) => path.isAbsolute(p), 'Local path must be absolute'),
  provider: providerKind,
  branch: branchName.default('develop'),
});
export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const preferencesSchema = z.object({
  syncStrategy: z.enum(['merge', 'exact']).default('merge'),
  transferViaPr: z.boolean().default(true),
  prDiscovery: z.enum(['api', 'manual']).default('api'),
  previewOnly: z.boolean().default(true),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const appConfigSchema = z
  .object({
    org: repoConfigSchema,
    intern: repoConfigSchema,
    preferences: preferencesSchema.default({}),
  })
  .superRefine((c, ctx) => {
    if (path.resolve(c.org.path).toLowerCase() === path.resolve(c.intern.path).toLowerCase()) {
      ctx.addIssue({ code: 'custom', path: ['intern', 'path'], message: 'Org and intern clones must be different directories' });
    }
  });
export type AppConfig = z.infer<typeof appConfigSchema>;

export const syncStrategy = z.enum(['merge', 'exact']);

export const syncPreviewRequest = z.object({
  strategy: syncStrategy,
  allowUnrelatedHistories: z.boolean().default(false),
});

export const syncApplyRequest = z.object({
  strategy: syncStrategy,
  allowUnrelatedHistories: z.boolean().default(false),
  expectOrgSha: commitSha,
  expectInternSha: commitSha,
  /** Exact sync discards intern-only commits from the branch tip; must be explicit. */
  confirmExact: z.boolean().default(false),
});

export const syncPushRequest = z.object({
  expectHeadSha: commitSha,
  confirmPush: z.literal(true, { errorMap: () => ({ message: 'Pushing requires explicit confirmation' }) }),
  confirmForcePush: z.boolean().default(false),
});

export const prStateFilter = z.enum(['open', 'merged', 'all']);

export const transferPlanRequest = z.object({
  prNumber: z.number().int().positive(),
});

export const transferStartRequest = z.object({
  prNumber: z.number().int().positive(),
  strategy: z.enum(['cherry-pick', 'patch']).default('cherry-pick'),
  commits: z.array(commitSha).max(500).default([]),
  allowRepeat: z.boolean().default(false),
});

export const transferResumeRequest = z.object({
  prNumber: z.number().int().positive(),
  action: z.enum(['continue', 'abort']),
});

export const transferPublishRequest = z.object({
  prNumber: z.number().int().positive(),
  expectTip: commitSha,
  confirmPush: z.literal(true, { errorMap: () => ({ message: 'Pushing requires explicit confirmation' }) }),
  title: z.string().trim().max(250).optional(),
});

export function parsePrNumber(input: string): number | null {
  const m = /\/pull\/(\d+)/.exec(input) ?? /^#?(\d+)$/.exec(input.trim());
  return m ? Number(m[1]) : null;
}
