import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SyncContext } from '@/server/workflows/sync';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function write(cwd: string, file: string, content: string): void {
  const p = path.join(cwd, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function commitFile(cwd: string, file: string, content: string, message: string): string {
  write(cwd, file, content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

export interface Scenario {
  root: string;
  orgBare: string;
  internBare: string;
  /** The app's configured clones. */
  orgClone: string;
  internClone: string;
  /** Separate "developer" clones used to advance remotes. */
  orgDev: string;
  internDev: string;
  seedSha: string;
  ctx(previewOnly?: boolean): SyncContext;
  advance(who: 'org' | 'intern', file: string, content: string, message: string): string;
  cleanup(): void;
}

/** Builds bare org/intern remotes plus clones, entirely on the local filesystem. */
export function makeScenario(opts: { sharedHistory?: boolean } = {}): Scenario {
  const shared = opts.sharedHistory ?? true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grs-sc-'));
  const p = (n: string) => path.join(root, n);
  const orgBare = p('org.git');
  const internBare = p('intern.git');
  git(root, 'init', '--bare', '-b', 'develop', orgBare);
  git(root, 'init', '--bare', '-b', 'develop', internBare);

  const seed = p('seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-b', 'develop');
  commitFile(seed, 'README.md', '# project\n', 'initial');
  commitFile(seed, 'src/app.txt', 'line1\nline2\nline3\n', 'add app');
  const seedSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', orgBare, 'develop');
  if (shared) git(seed, 'push', internBare, 'develop');
  else {
    const other = p('seed2');
    fs.mkdirSync(other);
    git(other, 'init', '-b', 'develop');
    commitFile(other, 'README.md', '# project (independent copy)\n', 'initial copy');
    commitFile(other, 'src/app.txt', 'line1\nline2\nline3\n', 'add app');
    git(other, 'push', internBare, 'develop');
  }

  const orgClone = p('org-clone');
  const internClone = p('intern-clone');
  const orgDev = p('org-dev');
  const internDev = p('intern-dev');
  git(root, 'clone', orgBare, orgClone);
  git(root, 'clone', internBare, internClone);
  git(root, 'clone', orgBare, orgDev);
  git(root, 'clone', internBare, internDev);

  return {
    root,
    orgBare,
    internBare,
    orgClone,
    internClone,
    orgDev,
    internDev,
    seedSha,
    ctx: (previewOnly = false) => ({
      org: { path: orgClone, url: orgBare, branch: 'develop' },
      intern: { path: internClone, url: internBare, branch: 'develop' },
      previewOnly,
    }),
    advance(who, file, content, message) {
      const dev = who === 'org' ? orgDev : internDev;
      git(dev, 'pull', '--ff-only', 'origin', 'develop');
      const sha = commitFile(dev, file, content, message);
      git(dev, 'push', 'origin', 'develop');
      return sha;
    },
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* best effort */
      }
    },
  };
}
