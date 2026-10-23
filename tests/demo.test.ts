import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createDemo } from '@/server/demo';
import { transferContext } from '@/server/context';
import { loadConfig } from '@/server/config';
import { listPullRequestsWithStatus, planTransfer } from '@/server/workflows/transfer';
import { previewSync } from '@/server/workflows/sync';
import { syncContext } from '@/server/context';

let root: string | undefined;
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('demo repositories', () => {
  it('seeds a runnable scenario: org ahead, intern PR branches, no symbolic-HEAD pseudo PR', async () => {
    const demo = await createDemo();
    root = demo.root;
    expect(loadConfig()?.org.path).toBe(demo.config.org.path);

    const pv = await previewSync(syncContext(), { strategy: 'merge' });
    expect(pv.relation).toBe('diverged');
    expect(pv.behindCount).toBe(2);
    expect(pv.aheadCount).toBe(1);

    const ctx = await transferContext();
    const prs = await listPullRequestsWithStatus(ctx, 'open');
    expect(prs.map((p) => p.sourceBranch)).toEqual(['feature/app-tweak', 'feature/login']);
    expect(ctx.orgProvider).toBeNull(); // 'other' provider: honest "no PR API"

    const plan = await planTransfer(ctx, { prNumber: 2 });
    expect(plan.commits.map((c) => c.status)).toEqual(['ready', 'ready']);
  });
});
