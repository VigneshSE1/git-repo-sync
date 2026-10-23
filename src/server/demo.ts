import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveConfig } from './config';
import { GitRepo } from './git/repo';
import { logEvent } from './log';
import type { AppConfig } from './validation';

const ID = ['-c', 'user.name=Demo User', '-c', 'user.email=demo@example.local'];

/**
 * Builds throw-away local "remotes" and clones so every workflow can be tried without touching real
 * repositories or credentials. The intern "PRs" are branches (see LocalDemoProvider); no remote API is faked.
 */
export async function createDemo(): Promise<{ root: string; config: AppConfig }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-sync-demo-'));
  const p = (n: string) => path.join(root, n);
  const sh = new GitRepo(root, 'demo');
  const gitIn = async (dir: string, ...args: string[]) => new GitRepo(dir, 'demo').run([...ID, ...args]);
  const write = (dir: string, file: string, content: string) => {
    const f = path.join(dir, file);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  };
  const commit = async (dir: string, file: string, content: string, message: string) => {
    write(dir, file, content);
    await gitIn(dir, 'add', '-A');
    await gitIn(dir, 'commit', '-m', message);
  };

  await sh.run(['init', '--bare', '-b', 'develop', p('org.git')]);
  await sh.run(['init', '--bare', '-b', 'develop', p('intern.git')]);
  const seed = p('seed');
  fs.mkdirSync(seed);
  await gitIn(seed, 'init', '-b', 'develop');
  await commit(seed, 'README.md', '# Demo project\n', 'Initial commit');
  await commit(seed, 'src/app.txt', 'line1\nline2\nline3\n', 'Add app');
  await gitIn(seed, 'push', p('org.git'), 'develop');
  await gitIn(seed, 'push', p('intern.git'), 'develop');

  // Org moves ahead (one change touches src/app.txt to make a PR conflict possible).
  const orgDev = p('org-dev');
  await sh.run(['clone', p('org.git'), orgDev]);
  await commit(orgDev, 'src/feature-org.txt', 'org feature\n', 'org: add feature');
  await commit(orgDev, 'src/app.txt', 'line1\nORG line2\nline3\n', 'org: tweak app');
  await gitIn(orgDev, 'push', 'origin', 'develop');

  // Intern has its own commit on develop plus two PR branches.
  const internDev = p('intern-dev');
  await sh.run(['clone', p('intern.git'), internDev]);
  await commit(internDev, 'notes/intern.md', 'intern notes\n', 'intern: add notes');
  await gitIn(internDev, 'push', 'origin', 'develop');
  await gitIn(internDev, 'switch', '-c', 'feature/login');
  await commit(internDev, 'src/login.txt', 'login v1\n', 'feat: login page');
  await commit(internDev, 'src/login.txt', 'login v2\n', 'feat: login validation');
  await gitIn(internDev, 'push', 'origin', 'feature/login');
  await gitIn(internDev, 'switch', 'develop');
  await gitIn(internDev, 'switch', '-c', 'feature/app-tweak');
  await commit(internDev, 'src/app.txt', 'line1\nINTERN line2\nline3\n', 'feat: change app line');
  await gitIn(internDev, 'push', 'origin', 'feature/app-tweak');

  const orgClone = p('org-clone');
  const internClone = p('intern-clone');
  await sh.run(['clone', p('org.git'), orgClone]);
  await sh.run(['clone', p('intern.git'), internClone]);
  for (const dir of [orgClone, internClone]) {
    await new GitRepo(dir, 'demo').run(['config', 'user.name', 'Demo User']);
    await new GitRepo(dir, 'demo').run(['config', 'user.email', 'demo@example.local']);
  }

  const config: AppConfig = {
    org: { url: p('org.git'), path: orgClone, provider: 'other', branch: 'develop' },
    intern: { url: p('intern.git'), path: internClone, provider: 'local', branch: 'develop' },
    preferences: { syncStrategy: 'merge', transferViaPr: true, prDiscovery: 'api', previewOnly: false },
  };
  saveConfig(config);
  logEvent({ scope: 'demo', kind: 'info', message: `Created demo repositories in ${root}` });
  return { root, config };
}
