import fs from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { AppError, classifyGitError } from '../errors';
import { logEvent } from '../log';
import { sameRemote } from '../remote';

export interface RunOptions {
  /** Return {ok:false} instead of throwing when git exits non-zero. */
  allowFail?: boolean;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  out: string;
  err: string;
}

export interface CommitSummary {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface FileChange {
  status: string;
  path: string;
  oldPath?: string;
}

export interface WorktreeStatus {
  /** True when there are no tracked (staged/unstaged/unmerged) changes. */
  clean: boolean;
  tracked: string[];
  untracked: string[];
  unmerged: string[];
}

export interface MergePreview {
  clean: boolean;
  unrelated: boolean;
  tree: string | null;
  conflicts: string[];
}

const FIELD = '%x1f';
const COMMIT_FORMAT = `%H${FIELD}%an${FIELD}%aI${FIELD}%s`;

function parseCommitLine(line: string): CommitSummary {
  const [sha, author, date, ...rest] = line.split('\x1f');
  return { sha, author, date, subject: rest.join('\x1f') };
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function canon(p: string): string {
  const r = real(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * Thin, argument-safe wrapper around simple-git. Every command is an argv array
 * (never a shell string) and every invocation is recorded in the operation log.
 */
export class GitRepo {
  constructor(
    readonly path: string,
    readonly label: string,
  ) {}

  async run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const started = Date.now();
    const git = simpleGit({
      baseDir: this.path,
      binary: 'git',
      maxConcurrentProcesses: 1,
      timeout: { block: opts.timeoutMs ?? 120_000 },
      config: ['core.quotepath=false'],
      // simple-git treats "non-zero exit with empty stderr" as success (e.g. a conflicted merge prints to
      // stdout). We need the real exit status, so any non-zero exit is turned into an error here; the streams
      // themselves are captured separately via outputHandler below.
      errors: (error, result) => error ?? (result.exitCode ? new Error(`git exited with code ${result.exitCode}`) : undefined),
      // These only relax simple-git's checks on *environment* variables we set ourselves (non-interactive
      // editor/pager) or inherit from the user's own shell (credential/SSH setup). Argument-level
      // protections (--upload-pack, -c, ...) stay on and no user input reaches env or config.
      unsafe: { allowUnsafeEditor: true, allowUnsafePager: true, allowUnsafeAskPass: true, allowUnsafeSshCommand: true, allowUnsafeConfigPaths: true, allowUnsafeConfigEnvCount: true },
    }).env({
      ...(process.env as Record<string, string>),
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_EDITOR: 'true',
      GIT_PAGER: 'cat',
      LC_ALL: 'C',
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    git.outputHandler((_cmd, stdout, stderr) => {
      stdout.on('data', (d: Buffer) => outChunks.push(d));
      stderr.on('data', (d: Buffer) => errChunks.push(d));
    });
    const cmd = `git ${args.join(' ')}`;
    try {
      const out = await git.raw(args);
      logEvent({ scope: this.label, kind: 'git', message: cmd, ok: true, durationMs: Date.now() - started, output: out.slice(0, 400) });
      return { ok: true, out, err: '' };
    } catch (e) {
      const out = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      const err = stderr.trim() || out.trim() || (e instanceof Error ? e.message : String(e));
      logEvent({ scope: this.label, kind: 'git', message: cmd, ok: false, durationMs: Date.now() - started, output: err });
      if (opts.allowFail) return { ok: false, out, err };
      throw classifyGitError(new Error(err, { cause: e }));
    }
  }

  private async text(args: string[], opts?: RunOptions): Promise<string> {
    return (await this.run(args, opts)).out.trim();
  }

  /** Resolves a ref to a full commit SHA, or null when it does not exist. */
  async resolve(ref: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
    const sha = r.out.trim();
    return r.ok && sha ? sha : null;
  }

  async treeOf(ref: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], { allowFail: true });
    return r.ok && r.out.trim() ? r.out.trim() : null;
  }

  async currentBranch(): Promise<string> {
    return this.text(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async status(): Promise<WorktreeStatus> {
    const out = await this.text(['status', '--porcelain=v1', '--untracked-files=normal']);
    const tracked: string[] = [];
    const untracked: string[] = [];
    const unmerged: string[] = [];
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      const xy = line.slice(0, 2);
      const file = line.slice(3);
      if (xy === '??') untracked.push(file);
      else {
        tracked.push(file);
        if (xy.includes('U') || xy === 'AA' || xy === 'DD') unmerged.push(file);
      }
    }
    return { clean: tracked.length === 0, tracked, untracked, unmerged };
  }

  async inProgressOperation(): Promise<'merge' | 'cherry-pick' | 'revert' | 'rebase' | null> {
    const heads: Array<['merge' | 'cherry-pick' | 'revert', string]> = [
      ['merge', 'MERGE_HEAD'],
      ['cherry-pick', 'CHERRY_PICK_HEAD'],
      ['revert', 'REVERT_HEAD'],
    ];
    for (const [name, ref] of heads) {
      const r = await this.run(['rev-parse', '-q', '--verify', ref], { allowFail: true });
      if (r.ok && r.out.trim()) return name;
    }
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const p = (await this.text(['rev-parse', '--git-path', dir])).trim();
      if (fs.existsSync(path.resolve(this.path, p))) return 'rebase';
    }
    return null;
  }

  async assertCleanAndIdle(): Promise<void> {
    const op = await this.inProgressOperation();
    if (op) {
      throw new AppError('OPERATION_IN_PROGRESS', `A ${op} is already in progress in ${this.label}.`, {
        hint: `Resolve it first (e.g. \`git ${op === 'rebase' ? 'rebase' : op} --abort\`) in ${this.path}.`,
      });
    }
    const st = await this.status();
    if (!st.clean) {
      throw new AppError('DIRTY_WORKTREE', `${this.label} has uncommitted changes; refusing to touch your working tree.`, {
        hint: 'Commit or stash your changes (`git stash`) and retry. Nothing was modified.',
        details: { files: st.tracked.slice(0, 50) },
      });
    }
  }

  async identity(): Promise<{ name: string | null; email: string | null }> {
    const name = (await this.run(['config', 'user.name'], { allowFail: true })).out.trim();
    const email = (await this.run(['config', 'user.email'], { allowFail: true })).out.trim();
    return { name: name || null, email: email || null };
  }

  /** Finds the name of the local remote whose URL matches `url`. */
  async findRemote(url: string): Promise<string | null> {
    const r = await this.run(['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true });
    for (const line of r.out.split(/\r?\n/).filter(Boolean)) {
      const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line);
      if (m && sameRemote(m[2].trim(), url)) return m[1];
    }
    return null;
  }

  async fetchRemote(remote: string): Promise<void> {
    await this.run(['fetch', '--prune', '--no-tags', remote], { timeoutMs: 180_000 });
  }

  /** Fetches `srcRef` from an arbitrary URL into a private local ref (no remote is added). */
  async fetchFromUrl(url: string, srcRef: string, destRef: string): Promise<void> {
    await this.run(['fetch', '--no-tags', '--', url, `+${srcRef}:${destRef}`], { timeoutMs: 180_000 });
  }

  async lsRemoteHead(remoteOrUrl: string, branch: string): Promise<string | null> {
    const out = await this.text(['ls-remote', '--heads', '--', remoteOrUrl, `refs/heads/${branch}`], { timeoutMs: 60_000 });
    const line = out.split(/\r?\n/).find(Boolean);
    return line ? line.split(/\s+/)[0] : null;
  }

  async commitInfo(ref: string): Promise<CommitSummary | null> {
    const sha = await this.resolve(ref);
    if (!sha) return null;
    const out = await this.text(['log', '-1', `--format=${COMMIT_FORMAT}`, sha]);
    return parseCommitLine(out);
  }

  async log(range: string, max = 200): Promise<CommitSummary[]> {
    const out = await this.text(['log', `--max-count=${max}`, `--format=${COMMIT_FORMAT}`, range]);
    return out.split(/\r?\n/).filter(Boolean).map(parseCommitLine);
  }

  async countRange(range: string): Promise<number> {
    return Number(await this.text(['rev-list', '--count', range]));
  }

  /** left = commits only in `a`, right = commits only in `b`. */
  async leftRight(a: string, b: string): Promise<{ left: number; right: number }> {
    const out = await this.text(['rev-list', '--left-right', '--count', `${a}...${b}`]);
    const [left, right] = out.split(/\s+/).map(Number);
    return { left: left ?? 0, right: right ?? 0 };
  }

  /** True when `a` is reachable from `b`. Uses stdout (not exit code) so it is unambiguous. */
  async isAncestor(a: string, b: string): Promise<boolean> {
    const out = await this.text(['rev-list', '--max-count=1', a, '--not', b]);
    return out === '';
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await this.run(['merge-base', a, b], { allowFail: true });
    return r.ok && r.out.trim() ? r.out.trim() : null;
  }

  async parents(sha: string): Promise<string[]> {
    const out = await this.text(['rev-list', '--parents', '--max-count=1', sha]);
    return out.split(/\s+/).slice(1);
  }

  async diffFiles(...revs: string[]): Promise<FileChange[]> {
    const out = await this.text(['diff', '--name-status', '--find-renames', ...revs]);
    return parseNameStatus(out);
  }

  async commitFiles(sha: string): Promise<FileChange[]> {
    const out = await this.text(['show', '--first-parent', '-m', '--name-status', '--find-renames', '--format=', sha]);
    return parseNameStatus(out);
  }

  async diffText(revs: string[], maxBytes = 400_000): Promise<{ text: string; truncated: boolean }> {
    const out = (await this.run(['diff', '--no-color', '--find-renames', '--binary', ...revs])).out;
    return out.length > maxBytes ? { text: out.slice(0, maxBytes), truncated: true } : { text: out, truncated: false };
  }

  async diffStat(...revs: string[]): Promise<string> {
    return this.text(['diff', '--stat', '--no-color', ...revs]);
  }

  /** Simulates a merge in-memory (no working tree changes). */
  async mergePreview(ours: string, theirs: string, allowUnrelated = false): Promise<MergePreview> {
    const base = await this.mergeBase(ours, theirs);
    if (!base && !allowUnrelated) return { clean: false, unrelated: true, tree: null, conflicts: [] };
    const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages'];
    if (!base) args.push('--allow-unrelated-histories');
    args.push(ours, theirs);
    const r = await this.run(args, { allowFail: true });
    const lines = r.out.split(/\r?\n/).filter((l) => l.trim());
    if (!r.ok && lines.length === 0) throw classifyGitError(r.err);
    const tree = lines[0] ?? null;
    const conflicts = [...new Set(lines.slice(1))];
    return { clean: conflicts.length === 0, unrelated: !base, tree, conflicts };
  }

  async branchExists(name: string): Promise<boolean> {
    return (await this.resolve(`refs/heads/${name}`)) !== null;
  }

  async switchBranch(name: string): Promise<void> {
    await this.run(['switch', name]);
  }

  async createBranch(name: string, startPoint: string, checkout = true): Promise<void> {
    if (checkout) await this.run(['switch', '-c', name, '--no-track', startPoint]);
    else await this.run(['branch', '--no-track', name, startPoint]);
  }

  async deleteBranch(name: string): Promise<void> {
    await this.run(['branch', '-D', name]);
  }

  async resetHard(sha: string): Promise<void> {
    await this.run(['reset', '--hard', sha]);
  }

  async fastForward(sha: string): Promise<void> {
    await this.run(['merge', '--ff-only', sha]);
  }

  async merge(sha: string, message: string, allowUnrelated: boolean): Promise<RunResult> {
    const args = ['merge', '--no-edit', '-m', message];
    if (allowUnrelated) args.push('--allow-unrelated-histories');
    args.push(sha);
    return this.run(args, { allowFail: true });
  }

  async mergeAbort(): Promise<void> {
    await this.run(['merge', '--abort']);
  }

  async cherryPick(sha: string): Promise<RunResult> {
    return this.run(['cherry-pick', '-x', sha], { allowFail: true });
  }

  async cherryPickContinue(): Promise<RunResult> {
    return this.run(['cherry-pick', '--continue'], { allowFail: true });
  }

  async cherryPickSkip(): Promise<void> {
    await this.run(['cherry-pick', '--skip']);
  }

  async cherryPickAbort(): Promise<void> {
    await this.run(['cherry-pick', '--abort']);
  }

  async applyPatch(file: string): Promise<RunResult> {
    return this.run(['apply', '--3way', '--index', '--whitespace=nowarn', file], { allowFail: true });
  }

  async commit(message: string): Promise<RunResult> {
    return this.run(['commit', '-m', message], { allowFail: true });
  }

  async unmergedFiles(): Promise<string[]> {
    const out = await this.text(['diff', '--name-only', '--diff-filter=U']);
    return out.split(/\r?\n/).filter(Boolean);
  }

  /** Patch-equivalence: returns SHAs in `head` (not in `upstream`) that already have an equivalent patch upstream. */
  async patchEquivalent(upstream: string, head: string): Promise<Set<string>> {
    const out = await this.text(['cherry', upstream, head]);
    const set = new Set<string>();
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      if (line.startsWith('- ')) set.add(line.slice(2).trim());
    }
    return set;
  }

  async hasConflictMarkers(): Promise<boolean> {
    const r = await this.run(['diff', '--check', '--cached'], { allowFail: true });
    return !r.ok && /conflict marker/i.test(`${r.out}\n${r.err}`);
  }

  async push(
    remote: string,
    localRef: string,
    remoteBranch: string,
    opts: { forceWithLeaseSha?: string; setUpstream?: boolean } = {},
  ): Promise<void> {
    const args = ['push'];
    if (opts.setUpstream) args.push('--set-upstream');
    if (opts.forceWithLeaseSha) args.push(`--force-with-lease=refs/heads/${remoteBranch}:${opts.forceWithLeaseSha}`);
    args.push('--', remote, `${localRef}:refs/heads/${remoteBranch}`);
    await this.run(args, { timeoutMs: 180_000 });
  }
}

export function parseNameStatus(out: string): FileChange[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0];
      if (status.startsWith('R') || status.startsWith('C')) return { status: status[0], oldPath: parts[1], path: parts[2] };
      return { status: status[0], path: parts[1] };
    });
}

export interface ValidatedRepo {
  repo: GitRepo;
  remote: string;
  currentBranch: string;
}

/**
 * Verifies path, work-tree root, remote identity and branch before any operation.
 * Throws REPO_INVALID with an actionable hint on the first problem found.
 */
export async function validateRepo(
  cfg: { path: string; url: string; branch: string },
  label: string,
  opts: { requireRemoteBranch?: boolean } = {},
): Promise<ValidatedRepo> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cfg.path);
  } catch {
    throw new AppError('REPO_INVALID', `${label}: local path does not exist (${cfg.path}).`, {
      hint: 'Clone the repository there first, or correct the path in Setup.',
    });
  }
  if (!stat.isDirectory()) throw new AppError('REPO_INVALID', `${label}: path is not a directory.`);

  const repo = new GitRepo(cfg.path, label);
  const inside = await repo.run(['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  if (!inside.ok || inside.out.trim() !== 'true') {
    throw new AppError('REPO_INVALID', `${label}: ${cfg.path} is not a Git working tree.`, {
      hint: 'Point to the root of a non-bare clone.',
    });
  }
  const top = (await repo.run(['rev-parse', '--show-toplevel'])).out.trim();
  if (canon(top) !== canon(cfg.path)) {
    throw new AppError('REPO_INVALID', `${label}: path is inside a repository but is not its root (${top}).`, {
      hint: 'Use the repository root directory.',
    });
  }
  const remote = await repo.findRemote(cfg.url);
  if (!remote) {
    throw new AppError('REPO_INVALID', `${label}: no remote in this clone matches ${cfg.url}.`, {
      hint: 'The clone points at a different repository. Check `git remote -v`, or fix the URL/path in Setup.',
    });
  }
  const currentBranch = await repo.currentBranch();
  if (opts.requireRemoteBranch) {
    const sha = await repo.resolve(`refs/remotes/${remote}/${cfg.branch}`);
    if (!sha) {
      throw new AppError('REPO_INVALID', `${label}: branch ${cfg.branch} not found on remote ${remote}.`, {
        hint: 'Fetch the repository or correct the branch name.',
      });
    }
  }
  return { repo, remote, currentBranch };
}
